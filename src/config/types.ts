export type MemberRole = "frontend" | "backend" | "other";
export type RepoRole = "frontend" | "backend" | "shared";

export interface AppConfig {
  timezone: string;
  agingUnit: "calendar-days";
  azure: {
    organization: string;
    project: string;
    process: string;
    apiVersion: string;
    areaPath: string;
    iterationPath: string;
    team: string;
    workItemTypes: Record<string, string>;
    fieldMap: Record<string, string>;
    stateMapping: Record<string, string>;
    writes: { enabled: boolean };
  };
  team: {
    members: Array<{
      id: string;
      azureId: string;
      displayName: string;
      role: MemberRole;
    }>;
  };
  repositories: Array<{
    repoId: string;
    role: RepoRole;
    localPath: string;
    baseRef: string;
    analysisCommand: string;
  }>;
  environments: Record<string, { alias: string; azureEnv: string }>;
  alerts: {
    spPendingDays: number;
    prOpenDays: number;
    wipLimit: number;
  };
  readiness: {
    requireConfirmedSpContract: boolean;
    requireAcceptanceCriteria: boolean;
    blockOnUnknownSp: boolean;
  };
  server: {
    host: string;
    port: number;
  };
  paths: {
    dataDir: string;
    reportsDir: string;
  };
}

export function isPlaceholderOrg(organization: string): boolean {
  return !organization || organization === "YOUR_ORG" || organization === "fabrikam-demo";
}
