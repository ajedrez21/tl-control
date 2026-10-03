export function workItemKey(organization: string, project: string, azureId: number | string): string {
  return `${organization}/${project}/${azureId}`;
}

export function parseWorkItemKey(id: string): { organization: string; project: string; azureId: number } {
  const parts = id.split("/");
  if (parts.length < 3) {
    throw new Error(`Identidad de Work Item inválida: ${id}. Use organización/proyecto/id`);
  }
  const azureId = Number(parts[parts.length - 1]);
  const project = parts[parts.length - 2];
  const organization = parts.slice(0, -2).join("/");
  if (!organization || !project || !Number.isInteger(azureId)) {
    throw new Error(`Identidad de Work Item inválida: ${id}`);
  }
  return { organization, project, azureId };
}

export function resolveWorkItemArg(
  raw: string,
  organization: string,
  project: string
): string {
  if (raw.includes("/")) return raw;
  const numeric = Number(raw.replace(/^#/, ""));
  if (!Number.isInteger(numeric)) {
    throw new Error(`ID de Work Item inválido: ${raw}`);
  }
  return workItemKey(organization, project, numeric);
}
