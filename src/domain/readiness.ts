export type Classification = "CONFIRMED" | "INFERRED" | "UNKNOWN";
export type ReadinessStatus = "DRAFT" | "BLOCKED" | "READY";
export type ContractStatus = "UNKNOWN" | "PROPOSED" | "CONFIRMED" | "NOT_APPLICABLE";
export type DependencyStatus = "UNKNOWN" | "PENDING" | "SATISFIED" | "NOT_APPLICABLE";
export type SpLifecycle =
  | "UNKNOWN"
  | "REQUESTED"
  | "IN_PROGRESS"
  | "CONTRACT_CONFIRMED"
  | "AVAILABLE"
  | "VALIDATED"
  | "BLOCKED"
  | "NOT_APPLICABLE";
export type GateStatus = "PASS" | "FAIL" | "REVIEW" | "NOT_RUN" | "NOT_AVAILABLE" | "STALE";
export type SourceCoverage = "OK" | "PARTIAL" | "NOT_AVAILABLE" | "ERROR" | "UNAUTHORIZED";

export interface ReadinessInput {
  hasAcceptanceCriteria: boolean;
  spContractStatus: ContractStatus | SpLifecycle;
  spDeploymentStatus: DependencyStatus | SpLifecycle;
  blockingGaps: number;
  contradictions: number;
  requireConfirmedSpContract: boolean;
  blockOnUnknownSp: boolean;
  requireAcceptanceCriteria: boolean;
  layerNeedsSp: boolean;
}

export function evaluateReadiness(input: ReadinessInput): { status: ReadinessStatus; reasons: string[] } {
  const reasons: string[] = [];
  if (input.requireAcceptanceCriteria && !input.hasAcceptanceCriteria) {
    reasons.push("Faltan criterios de aceptación confirmados.");
  }
  if (input.blockingGaps > 0) {
    reasons.push(`${input.blockingGaps} pregunta(s) bloqueante(s) sin responder.`);
  }
  if (input.contradictions > 0) {
    reasons.push("Hay contradicciones entre fuentes; requieren decisión del TL.");
  }
  if (input.layerNeedsSp) {
    const contractUnknown =
      input.spContractStatus === "UNKNOWN" ||
      input.spContractStatus === "REQUESTED" ||
      input.spContractStatus === "IN_PROGRESS" ||
      input.spContractStatus === "BLOCKED" ||
      input.spContractStatus === "PROPOSED";
    if (input.blockOnUnknownSp && contractUnknown) {
      reasons.push("Contrato de SP no confirmado: no se declara Ready ni se inventa la firma.");
    }
    if (input.requireConfirmedSpContract && input.spContractStatus !== "CONFIRMED" && input.spContractStatus !== "CONTRACT_CONFIRMED" && input.spContractStatus !== "AVAILABLE" && input.spContractStatus !== "VALIDATED" && input.spContractStatus !== "NOT_APPLICABLE") {
      if (!reasons.some((r) => r.includes("Contrato de SP"))) {
        reasons.push("El contrato SP no está CONFIRMED/CONTRACT_CONFIRMED.");
      }
    }
  }
  if (reasons.length > 0) return { status: "BLOCKED", reasons };
  return { status: "READY", reasons: ["Contexto mínimo cubierto."] };
}

export function productionConfirmed(opts: {
  azureState: string;
  merged: boolean;
  buildSucceeded: boolean;
  deployment?: { environment: string; status: string; source: string } | null;
  productionAlias: string;
}): boolean {
  const deploy = opts.deployment;
  if (!deploy) return false;
  const envMatch = deploy.environment.toLowerCase() === opts.productionAlias.toLowerCase() || deploy.environment.toLowerCase() === "production" || deploy.environment.toLowerCase() === "prod";
  return envMatch && deploy.status === "success";
}
