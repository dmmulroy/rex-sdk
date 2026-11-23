/**
 * Documented-shape arguments and results for every block method, shared by the contract sweep and
 * other suites that call block methods through the test server. Each result satisfies the method's
 * output schema, so the test server records no violation.
 *
 * @since 0.1.0
 */
import type { Schema } from "effect";
import type { RexBlockMethod } from "../generated/rex-wire-schemas.ts";

const updatedAt = "2026-10-29T00:00:00Z";

/** Wire arguments and a wire result for each block method a namespace owns. */
export const rexBlockMethodExamples = {
  "com.superlogical.terminal.write": {
    args: { data: "ls\r" },
    result: { bytes_written: 3 },
  },
  "com.superlogical.terminal.format": {
    args: { trim: true },
    result: { content: "$ ls" },
  },
  "com.superlogical.terminal.blob_read": {
    args: { id: 4, offset: 10 },
    result: { id: 4, data: "rest", total: 14, eof: true },
  },
  "com.superlogical.terminal.clear": {
    args: {},
    result: {},
  },
  "com.superlogical.terminal.reset": {
    args: {},
    result: {},
  },
  "com.superlogical.terminal.resize": {
    args: { columns: 120, rows: 40 },
    result: {},
  },
  "com.superlogical.terminal.size": {
    args: {},
    result: {
      columns: 120,
      rows: 40,
      cell_width_px: 9,
      cell_height_px: 18,
      owner: null,
      desired: [
        {
          client_id: "client:01234567-89ab-cdef-0123-456789abcdef",
          columns: 120,
          rows: 40,
          updated_at: updatedAt,
        },
      ],
    },
  },
  "com.superlogical.terminal.set_theme": {
    args: { foreground: "#ffffff", background: "#000000" },
    result: {},
  },
  "com.superlogical.terminal.title": {
    args: {},
    result: { title: "zsh", owner: { pid: 42, name: "zsh" } },
  },
  "com.superlogical.terminal.pwd": {
    args: {},
    result: { pwd: "file://host/Users/me", owner: { pid: 42, name: "zsh" } },
  },
  "com.superlogical.terminal.process": {
    args: {},
    result: {
      last_exit: null,
      child: { pid: 42, user_id: 501, name: "zsh" },
    },
  },
  "com.superlogical.terminal.modes": {
    args: {},
    result: {
      screen: "primary",
      modes: [{ name: "bracketed_paste", number: 2004, set: true }],
    },
  },
  "com.superlogical.terminal.input_mode": {
    args: {},
    result: { echo: true, canonical: true, signals: true },
  },
  "com.superlogical.terminal.list_dir": {
    args: { path: "~", files: true },
    result: {
      path: "/Users/me",
      home: "/Users/me",
      status: "ok",
      entries: [{ name: "src" }, { name: "README.md", file: true }],
      truncated: false,
    },
  },
  "com.superlogical.terminal.clipboard_read": {
    args: { id: 2 },
    result: { id: 2, data: "copied", total: 6, eof: true },
  },
  "com.superlogical.terminal.program_status": {
    args: {},
    result: {
      records: [{ id: "agent", state: "working", updated_at: updatedAt }],
    },
  },
  "com.superlogical.terminal.ports": {
    args: {},
    result: {
      status: "ok",
      ports: [
        { port: 5173, address: "127.0.0.1", protocol: "tcp", first_seen_at: updatedAt, pid: 42 },
      ],
      processes: [{ pid: 42, user_id: 501, name: "node", cwd: "/Users/me/app" }],
    },
  },
  "com.superlogical.terminal.download_begin": {
    args: {
      ref: "download:01234567-89ab-cdef-0123-456789abcdef",
      path: "report.csv",
      if_none_match: "v1",
    },
    result: {
      not_modified: true,
      path: "/srv/report.csv",
      name: "report.csv",
      size: 11,
      modified_at: updatedAt,
      version: "v1",
    },
  },
  "com.superlogical.terminal.upload_begin": {
    args: { ref: "upload:01234567-89ab-cdef-0123-456789abcdef", name: "notes.txt", size: 5 },
    result: { ticket: "AAECAwQFBgcICQoLDA0ODw", expires_in_ms: 60_000 },
  },
  "com.superlogical.tunnel.info": {
    args: {},
    result: { flavor: "dial", target: "127.0.0.1:5432", connections: 1 },
  },
} satisfies Partial<
  Record<RexBlockMethod, { readonly args: Schema.Json; readonly result: Schema.Json }>
>;
