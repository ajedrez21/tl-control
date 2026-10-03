import type { Db } from "../../storage/db.ts";
import { run } from "../../storage/db.ts";
import { nowIso } from "../../domain/time.ts";
import type { GateStatus } from "../../domain/readiness.ts";

export interface SecurityReportInput {
  id: string;
  source: string;
  gateStatus: GateStatus;
  checkedAt: string | null;
  fingerprint: string | null;
  findings: Array<{ id: string; severity: string; title: string; status: string; path?: string }>;
}

export function importSecurityReport(db: Db, report: SecurityReportInput, currentGate: boolean): void {
  if (currentGate) {
    run(db, "UPDATE security_reports SET current_gate = 0");
  }
  run(
    db,
    `INSERT INTO security_reports(id, imported_at, source, gate_status, checked_at, fingerprint, payload_json, current_gate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       imported_at=excluded.imported_at,
       gate_status=excluded.gate_status,
       checked_at=excluded.checked_at,
       fingerprint=excluded.fingerprint,
       payload_json=excluded.payload_json,
       current_gate=excluded.current_gate`,
    report.id,
    nowIso(),
    report.source,
    report.gateStatus,
    report.checkedAt,
    report.fingerprint,
    JSON.stringify(report),
    currentGate ? 1 : 0
  );
  run(db, "DELETE FROM findings WHERE report_id = ?", report.id);
  for (const f of report.findings) {
    run(
      db,
      "INSERT INTO findings(id, report_id, severity, title, status, path) VALUES (?, ?, ?, ?, ?, ?)",
      f.id,
      report.id,
      f.severity,
      f.title,
      f.status,
      f.path ?? null
    );
  }
}
