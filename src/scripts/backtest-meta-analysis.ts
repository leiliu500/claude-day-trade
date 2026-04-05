#!/usr/bin/env npx tsx
/**
 * backtest-meta-analysis.ts — Analyze META-signals that predict entry quality:
 * time of day, entry sequence position, day character, prior entry outcome.
 *
 * These are session-level patterns, not technical indicators.
 *
 * Usage:
 *   npx tsx src/scripts/backtest-meta-analysis.ts [START] [END] [TICKER]
 */

import 'dotenv/config';
import { execSync } from 'child_process';

const START = process.argv[2] || '2026-01-02';
const END = process.argv[3] || '2026-04-03';
const TICKER = process.argv[4]?.toUpperCase() || 'SPY';

function getTradingDays(start: string, end: string): string[] {
  const days: string[] = [];
  const d = new Date(start + 'T12:00:00Z');
  const endD = new Date(end + 'T12:00:00Z');
  while (d <= endD) {
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

const HOLIDAYS = new Set(['2025-11-27', '2025-12-25', '2026-01-01', '2026-01-19', '2026-02-16']);

interface Entry {
  date: string;
  timeET: string;
  minutesSinceOpen: number;
  direction: string;
  mode: string;
  confidence: number;
  grade: string;
  outcome: string;
  mfePct: number;
  maePct: number;
  seqNum: number;       // 1st, 2nd, 3rd... entry of the day
  priorGrade: string | null;  // grade of previous entry same day
  dayFirstGrade: string | null; // grade of first entry that day
}

const pad = (s: string, n: number) => s.padEnd(n);
const rpad = (s: string, n: number) => s.padStart(n);

function winRate(entries: Entry[]): string {
  if (entries.length === 0) return '  -  ';
  const good = entries.filter(e => e.outcome === 'GOOD').length;
  return `${(good / entries.length * 100).toFixed(0)}%`;
}

async function main() {
  const allDays = getTradingDays(START, END).filter(d => !HOLIDAYS.has(d));

  console.log(`\n${'='.repeat(90)}`);
  console.log(`  META-SIGNAL ANALYSIS: ${TICKER} ${START} -> ${END}`);
  console.log(`${'='.repeat(90)}\n`);

  const allEntries: Entry[] = [];
  let processed = 0;

  for (const date of allDays) {
    processed++;
    const pct = ((processed / allDays.length) * 100).toFixed(0);
    process.stdout.write(`  [${pct}%] ${date} ...`);

    try {
      const output = execSync(
        `npx tsx src/scripts/backtest-day.ts ${date} ${TICKER} --json 2>&1`,
        { timeout: 180_000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );

      const jsonMatch = output.match(/__JSON_START__(.+?)__JSON_END__/);
      if (!jsonMatch) { process.stdout.write(` no JSON\n`); continue; }

      const dayData = JSON.parse(jsonMatch[1]!);
      const confirmed = dayData.confirmed as any[];

      for (let i = 0; i < confirmed.length; i++) {
        const e = confirmed[i];
        // Parse time to minutes since 9:30 ET
        const [hh, mm] = e.timeET.split(':').map(Number);
        const minutesSinceOpen = (hh - 9) * 60 + (mm - 30);

        allEntries.push({
          date,
          timeET: e.timeET,
          minutesSinceOpen,
          direction: e.direction,
          mode: e.mode,
          confidence: e.confidence,
          grade: e.grade,
          outcome: e.outcome,
          mfePct: e.mfePct,
          maePct: e.maePct,
          seqNum: i + 1,
          priorGrade: i > 0 ? confirmed[i - 1].grade : null,
          dayFirstGrade: confirmed[0]?.grade ?? null,
        });
      }

      const grades = confirmed.map((e: any) => e.grade).join('');
      process.stdout.write(` ${confirmed.length} entries [${grades}]\n`);
    } catch {
      process.stdout.write(` ERROR\n`);
    }
  }

  const good = allEntries.filter(e => e.outcome === 'GOOD').length;
  const bad = allEntries.filter(e => e.outcome === 'BAD').length;
  console.log(`\n  Collected ${allEntries.length} entries | ${good} GOOD (${(good/allEntries.length*100).toFixed(0)}%) | ${bad} BAD\n`);

  // ── 1. TIME OF DAY ───────────────────────────────────────────────────────
  console.log(`${'='.repeat(90)}`);
  console.log(`  SECTION 1: TIME OF DAY`);
  console.log(`${'='.repeat(90)}\n`);

  const timeSlots = [
    { label: '09:30-10:00', min: 0, max: 30 },
    { label: '10:00-10:30', min: 30, max: 60 },
    { label: '10:30-11:00', min: 60, max: 90 },
    { label: '11:00-11:30', min: 90, max: 120 },
    { label: '11:30-12:00', min: 120, max: 150 },
    { label: '12:00-12:30', min: 150, max: 180 },
    { label: '12:30-13:00', min: 180, max: 210 },
    { label: '13:00-13:30', min: 210, max: 240 },
    { label: '13:30-14:00', min: 240, max: 270 },
    { label: '14:00-14:30', min: 270, max: 300 },
    { label: '14:30-15:00', min: 300, max: 330 },
    { label: '15:00-15:30', min: 330, max: 360 },
    { label: '15:30-16:00', min: 360, max: 390 },
  ];

  console.log(`  ${pad('Time', 14)} ${rpad('N', 4)} ${rpad('Good%', 6)} ${rpad('Bad%', 6)} ${rpad('Grades', 18)} ${rpad('AvgMFE', 8)} ${rpad('AvgMAE', 8)}`);
  console.log(`  ${'-'.repeat(68)}`);

  for (const slot of timeSlots) {
    const se = allEntries.filter(e => e.minutesSinceOpen >= slot.min && e.minutesSinceOpen < slot.max);
    if (se.length === 0) continue;
    const sGood = se.filter(e => e.outcome === 'GOOD').length;
    const sBad = se.filter(e => e.outcome === 'BAD').length;
    const sMfe = se.reduce((s, e) => s + e.mfePct, 0) / se.length;
    const sMae = se.reduce((s, e) => s + e.maePct, 0) / se.length;
    const grades = `${se.filter(e=>e.grade==='A').length}A ${se.filter(e=>e.grade==='B').length}B ${se.filter(e=>e.grade==='C').length}C ${se.filter(e=>e.grade==='D').length}D ${se.filter(e=>e.grade==='F').length}F`;
    console.log(`  ${pad(slot.label, 14)} ${rpad(String(se.length), 4)} ${rpad((sGood/se.length*100).toFixed(0)+'%', 6)} ${rpad((sBad/se.length*100).toFixed(0)+'%', 6)} ${rpad(grades, 18)} ${rpad(sMfe.toFixed(3)+'%', 8)} ${rpad(sMae.toFixed(3)+'%', 8)}`);
  }

  // ── 2. ENTRY SEQUENCE NUMBER ──────────────────────────────────────────────
  console.log(`\n${'='.repeat(90)}`);
  console.log(`  SECTION 2: ENTRY SEQUENCE NUMBER (1st, 2nd, 3rd... entry of day)`);
  console.log(`${'='.repeat(90)}\n`);

  console.log(`  ${pad('Entry #', 10)} ${rpad('N', 4)} ${rpad('Good%', 6)} ${rpad('Bad%', 6)} ${rpad('AvgMFE', 8)} ${rpad('AvgConf', 8)}`);
  console.log(`  ${'-'.repeat(46)}`);

  for (let seq = 1; seq <= 6; seq++) {
    const se = allEntries.filter(e => e.seqNum === seq);
    if (se.length === 0) continue;
    const sGood = se.filter(e => e.outcome === 'GOOD').length;
    const sBad = se.filter(e => e.outcome === 'BAD').length;
    const sMfe = se.reduce((s, e) => s + e.mfePct, 0) / se.length;
    const sConf = se.reduce((s, e) => s + e.confidence, 0) / se.length;
    console.log(`  ${pad('#' + seq, 10)} ${rpad(String(se.length), 4)} ${rpad((sGood/se.length*100).toFixed(0)+'%', 6)} ${rpad((sBad/se.length*100).toFixed(0)+'%', 6)} ${rpad(sMfe.toFixed(3)+'%', 8)} ${rpad(sConf.toFixed(1)+'%', 8)}`);
  }

  // ── 3. DAY CHARACTER (based on first entry grade) ─────────────────────────
  console.log(`\n${'='.repeat(90)}`);
  console.log(`  SECTION 3: DAY CHARACTER (first entry grade predicts rest of day?)`);
  console.log(`${'='.repeat(90)}\n`);

  console.log(`  ${pad('1st Grade', 12)} ${rpad('Days', 5)} ${rpad('N(rest)', 8)} ${rpad('Good%', 6)} ${rpad('Bad%', 6)} ${rpad('AvgMFE', 8)} ${rpad('Avg#Ent', 8)}`);
  console.log(`  ${'-'.repeat(57)}`);

  for (const firstGrade of ['A', 'B', 'C', 'D', 'F']) {
    // Get all entries AFTER the first one, on days where first entry was this grade
    const daysWithFirst = [...new Set(allEntries.filter(e => e.seqNum === 1 && e.grade === firstGrade).map(e => e.date))];
    const restEntries = allEntries.filter(e => e.seqNum > 1 && daysWithFirst.includes(e.date));
    if (restEntries.length === 0) continue;
    const rGood = restEntries.filter(e => e.outcome === 'GOOD').length;
    const rBad = restEntries.filter(e => e.outcome === 'BAD').length;
    const rMfe = restEntries.reduce((s, e) => s + e.mfePct, 0) / restEntries.length;
    const avgEntries = restEntries.length / daysWithFirst.length;
    console.log(`  ${pad('1st=' + firstGrade, 12)} ${rpad(String(daysWithFirst.length), 5)} ${rpad(String(restEntries.length), 8)} ${rpad((rGood/restEntries.length*100).toFixed(0)+'%', 6)} ${rpad((rBad/restEntries.length*100).toFixed(0)+'%', 6)} ${rpad(rMfe.toFixed(3)+'%', 8)} ${rpad(avgEntries.toFixed(1), 8)}`);
  }

  // ── 4. PRIOR ENTRY OUTCOME → NEXT ENTRY OUTCOME ──────────────────────────
  console.log(`\n${'='.repeat(90)}`);
  console.log(`  SECTION 4: PRIOR ENTRY OUTCOME → NEXT ENTRY QUALITY`);
  console.log(`${'='.repeat(90)}\n`);

  console.log(`  ${pad('Prior Grade', 14)} ${rpad('N(next)', 8)} ${rpad('Good%', 6)} ${rpad('Bad%', 6)} ${rpad('AvgMFE', 8)}`);
  console.log(`  ${'-'.repeat(46)}`);

  for (const pg of ['A', 'B', 'C', 'D', 'F']) {
    const next = allEntries.filter(e => e.priorGrade === pg);
    if (next.length === 0) continue;
    const nGood = next.filter(e => e.outcome === 'GOOD').length;
    const nBad = next.filter(e => e.outcome === 'BAD').length;
    const nMfe = next.reduce((s, e) => s + e.mfePct, 0) / next.length;
    console.log(`  ${pad('After ' + pg, 14)} ${rpad(String(next.length), 8)} ${rpad((nGood/next.length*100).toFixed(0)+'%', 6)} ${rpad((nBad/next.length*100).toFixed(0)+'%', 6)} ${rpad(nMfe.toFixed(3)+'%', 8)}`);
  }

  // ── 5. DIRECTION PERSISTENCE ──────────────────────────────────────────────
  console.log(`\n${'='.repeat(90)}`);
  console.log(`  SECTION 5: DIRECTION FLIP → ENTRY QUALITY`);
  console.log(`${'='.repeat(90)}\n`);

  const sameDir = allEntries.filter(e => {
    const idx = allEntries.indexOf(e);
    if (idx === 0) return false;
    const prev = allEntries[idx - 1];
    return prev && prev.date === e.date && prev.direction === e.direction;
  });
  const flipped = allEntries.filter(e => {
    const idx = allEntries.indexOf(e);
    if (idx === 0) return false;
    const prev = allEntries[idx - 1];
    return prev && prev.date === e.date && prev.direction !== e.direction;
  });

  console.log(`  ${pad('Condition', 18)} ${rpad('N', 4)} ${rpad('Good%', 6)} ${rpad('Bad%', 6)} ${rpad('AvgMFE', 8)}`);
  console.log(`  ${'-'.repeat(46)}`);

  if (sameDir.length > 0) {
    const g = sameDir.filter(e => e.outcome === 'GOOD').length;
    const b = sameDir.filter(e => e.outcome === 'BAD').length;
    console.log(`  ${pad('Same direction', 18)} ${rpad(String(sameDir.length), 4)} ${rpad((g/sameDir.length*100).toFixed(0)+'%', 6)} ${rpad((b/sameDir.length*100).toFixed(0)+'%', 6)} ${rpad((sameDir.reduce((s,e)=>s+e.mfePct,0)/sameDir.length).toFixed(3)+'%', 8)}`);
  }
  if (flipped.length > 0) {
    const g = flipped.filter(e => e.outcome === 'GOOD').length;
    const b = flipped.filter(e => e.outcome === 'BAD').length;
    console.log(`  ${pad('Direction flip', 18)} ${rpad(String(flipped.length), 4)} ${rpad((g/flipped.length*100).toFixed(0)+'%', 6)} ${rpad((b/flipped.length*100).toFixed(0)+'%', 6)} ${rpad((flipped.reduce((s,e)=>s+e.mfePct,0)/flipped.length).toFixed(3)+'%', 8)}`);
  }

  // ── 6. CONSECUTIVE LOSSES ─────────────────────────────────────────────────
  console.log(`\n${'='.repeat(90)}`);
  console.log(`  SECTION 6: CONSECUTIVE PRIOR LOSSES → NEXT ENTRY QUALITY`);
  console.log(`${'='.repeat(90)}\n`);

  console.log(`  ${pad('Consec losses', 16)} ${rpad('N(next)', 8)} ${rpad('Good%', 6)} ${rpad('Bad%', 6)} ${rpad('AvgMFE', 8)}`);
  console.log(`  ${'-'.repeat(48)}`);

  for (let streak = 0; streak <= 4; streak++) {
    // entries where the prior `streak` entries on the same day were all F
    const matching = allEntries.filter(e => {
      if (e.seqNum <= streak) return false;
      const dayEntries = allEntries.filter(d => d.date === e.date);
      const myIdx = dayEntries.indexOf(e);
      if (myIdx < streak) return false;
      let allF = true;
      for (let k = 1; k <= streak; k++) {
        if (dayEntries[myIdx - k]?.grade !== 'F') { allF = false; break; }
      }
      if (streak === 0) {
        // No prior losses — previous entry was NOT F (or first entry)
        return myIdx === 0 || dayEntries[myIdx - 1]?.grade !== 'F';
      }
      return allF;
    });
    if (matching.length === 0) continue;
    const g = matching.filter(e => e.outcome === 'GOOD').length;
    const b = matching.filter(e => e.outcome === 'BAD').length;
    const label = streak === 0 ? 'After 0 losses' : `After ${streak} F${streak > 1 ? "'s" : ''}`;
    console.log(`  ${pad(label, 16)} ${rpad(String(matching.length), 8)} ${rpad((g/matching.length*100).toFixed(0)+'%', 6)} ${rpad((b/matching.length*100).toFixed(0)+'%', 6)} ${rpad((matching.reduce((s,e)=>s+e.mfePct,0)/matching.length).toFixed(3)+'%', 8)}`);
  }

  console.log(`\n${'='.repeat(90)}\n`);
}

main().catch(err => { console.error('Failed:', err); process.exit(1); });
