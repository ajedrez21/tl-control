const GUID = "([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})";
const AZURE_ATTACHMENT_SOURCE = `https://dev\\.azure\\.com/[^"'\\s>]+/_apis/wit/attachments/${GUID}(?:\\?[^"'\\s>]*)?`;

export function localAzureAttachmentPath(guid: string): string {
  return `/attachments/azure/${guid.toLowerCase()}`;
}

export function azureAttachmentGuid(url: string): string | null {
  const match = url.match(new RegExp(AZURE_ATTACHMENT_SOURCE, "i"));
  return match?.[1] ? match[1].toLowerCase() : null;
}

export function rewriteAzureAttachmentUrl(src: string): string {
  const guid = azureAttachmentGuid(src);
  return guid ? localAzureAttachmentPath(guid) : src;
}

export function rewriteAzureAttachmentUrls(html: string): string {
  if (!html) return html;
  return html.replace(new RegExp(AZURE_ATTACHMENT_SOURCE, "gi"), (_match, guid: string) =>
    localAzureAttachmentPath(guid)
  );
}

export function isSafeAzureAttachmentUrl(url: string, guid: string, organization: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  const org = organization.toLowerCase();
  const path = decodeURIComponent(parsed.pathname).toLowerCase();
  const id = guid.toLowerCase();
  if (!path.includes(`/_apis/wit/attachments/${id}`)) return false;
  if (host === "dev.azure.com") return path.startsWith(`/${org}/`);
  return host === `${org}.visualstudio.com`;
}

export function azureAttachmentDownloadUrl(input: {
  organization: string;
  project: string;
  apiVersion: string;
  guid: string;
}): string {
  const q = new URLSearchParams({ download: "true", "api-version": input.apiVersion });
  return `https://dev.azure.com/${encodeURIComponent(input.organization)}/${encodeURIComponent(input.project)}/_apis/wit/attachments/${input.guid}?${q.toString()}`;
}
