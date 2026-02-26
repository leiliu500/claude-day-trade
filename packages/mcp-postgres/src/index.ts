#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Pool } from 'pg';
import { z } from 'zod';

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
const server = new McpServer({ name: 'mcp-postgres', version: '1.0.0' });

// ── Read-only query ────────────────────────────────────────────────────────────
server.tool(
  'pg_query',
  'Execute a read-only SELECT query against the trading database',
  {
    sql: z.string().describe('SQL SELECT statement'),
    params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe('Query parameters'),
  },
  async ({ sql, params }) => {
    // Safety: only allow SELECT statements
    const normalized = sql.trim().toUpperCase();
    if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'Only SELECT queries allowed via pg_query' }) }],
        isError: true,
      };
    }

    try {
      const result = await pool.query(sql, params ?? []);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ rows: result.rows, rowCount: result.rowCount }),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: (err as Error).message }) }],
        isError: true,
      };
    }
  }
);

// ── Write query ────────────────────────────────────────────────────────────────
server.tool(
  'pg_execute',
  'Execute an INSERT, UPDATE, or DELETE query against the trading database',
  {
    sql: z.string().describe('SQL INSERT/UPDATE/DELETE statement'),
    params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe('Query parameters'),
  },
  async ({ sql, params }) => {
    // Block SELECT via this endpoint (not needed, but good hygiene)
    const normalized = sql.trim().toUpperCase();
    if (normalized.startsWith('SELECT')) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'Use pg_query for SELECT statements' }) }],
        isError: true,
      };
    }

    try {
      const result = await pool.query(sql, params ?? []);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ rowCount: result.rowCount, command: result.command }),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: (err as Error).message }) }],
        isError: true,
      };
    }
  }
);

// ── Convenience: list tables ───────────────────────────────────────────────────
server.tool(
  'pg_list_tables',
  'List all tables in the trading schema',
  {},
  async () => {
    const result = await pool.query(`
      SELECT table_name, pg_size_pretty(pg_total_relation_size(quote_ident(table_name)::regclass)) AS size
      FROM information_schema.tables
      WHERE table_schema = 'trading'
      ORDER BY table_name
    `);
    return { content: [{ type: 'text', text: JSON.stringify(result.rows) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
