import type { AppConfig } from "../config/types.ts";
import { htmlToText } from "../domain/sanitize.ts";
import { nowIso } from "../domain/time.ts";
import type { Db } from "../storage/db.ts";
import { all, get, run } from "../storage/db.ts";

export const FUNCTIONAL_QUESTION_MARKER = "tl-func-q";

export interface FunctionalSource {
  azureId: number;
  title: string;
  descriptionText: string;
  descriptionHtml: string;
  acceptanceCriteria: string | null;
}

export interface FunctionalDraft {
  code: string;
  question: string;
}

export interface FunctionalQuestionGroup {
  workItemId: string;
  azureId: number;
  title: string;
  targetAzureId: number;
  postedAt: string | null;
  questions: Array<{ id: string; question: string }>;
  copyText: string;
}

export function deriveFunctionalQuestions(items: FunctionalSource[]): FunctionalDraft[] {
  const root = items[0];
  if (!root) return [];
  const blob = items.map((item) => `${item.title}\n${item.descriptionText}`).join("\n");
  const drafts: FunctionalDraft[] = [];

  if (/sub\s*men[uú]|nueva pantalla|nuevo men[uú]/i.test(blob)) {
    drafts.push({
      code: "menu-place",
      question: "¿En qué submenú va y cómo se va a llamar el ítem?"
    });
    drafts.push({
      code: "menu-permission",
      question: "¿Qué permiso habilita el ítem nuevo de menú?"
    });
  }

  const seenRefs = new Set<string>();
  for (const match of blob.matchAll(/misma funcionalidad(?:es)?\s+que\s+([^\n.]+)|igual a\s+([^\n.]+)/gi)) {
    const ref = cleanRef(match[1] || match[2] || "");
    const key = ref.toLowerCase();
    if (!ref || seenRefs.has(key)) continue;
    seenRefs.add(key);
    drafts.push({
      code: `reference-${slug(ref)}`,
      question: `¿Qué pantalla existente es «${ref}» (ruta de menú) para repetir ese comportamiento?`
    });
  }

  if (/tooltip/i.test(blob)) {
    drafts.push({
      code: "tooltip-target",
      question: "¿En qué grilla y columna va el tooltip, y qué texto muestra?"
    });
  }

  const imageItem = items.find((item) => /<img\b/i.test(item.descriptionHtml));
  if (imageItem) {
    drafts.push({
      code: "screenshot",
      question: `¿Qué hay que tomar de la captura de #${imageItem.azureId}?`
    });
  }

  if (drafts.length && !items.some((item) => item.acceptanceCriteria?.trim())) {
    drafts.push({
      code: "acceptance",
      question: `¿Cuáles son los criterios de aceptación de #${root.azureId}?`
    });
  }

  return drafts;
}

export function functionalQuestionsCopy(azureId: number, title: string, questions: string[]): string {
  const lines = questions.map((question, index) => `${index + 1}. ${question}`);
  return `Para #${azureId} ${title} faltan estas definiciones:\n${lines.join("\n")}\nCuando respondan, se puede seguir con la historia. (${FUNCTIONAL_QUESTION_MARKER})`;
}

export function syncFunctionalQuestions(db: Db, workItemId: string, items: FunctionalSource[]): void {
  const desired = deriveFunctionalQuestions(items);
  const codes = new Set(desired.map((draft) => draft.code));
  const existing = all<{ id: string; code: string | null; status: string | null }>(
    db,
    "SELECT id, code, status FROM questions WHERE work_item_id = ? AND id LIKE 'qfn-%'",
    workItemId
  );
  for (const row of existing) {
    if (row.status === "answered") continue;
    if (row.code && !codes.has(row.code)) {
      run(db, "DELETE FROM questions WHERE id = ?", row.id);
    }
  }
  const askedAt = nowIso();
  for (const draft of desired) {
    const id = questionId(workItemId, draft.code);
    const current = get<{ status: string | null }>(db, "SELECT status FROM questions WHERE id = ?", id);
    if (current?.status === "answered") continue;
    if (current) {
      run(db, "UPDATE questions SET question = ?, code = ? WHERE id = ?", draft.question, draft.code, id);
      continue;
    }
    run(
      db,
      `INSERT INTO questions(id, work_item_id, question, blocking, evidence_ids, status, code, asked_at)
       VALUES (?, ?, ?, 1, '[]', 'pending', ?, ?)`,
      id,
      workItemId,
      draft.question,
      draft.code,
      askedAt
    );
  }
}

export function listFunctionalQuestions(db: Db, iterationId: string): FunctionalQuestionGroup[] {
  settleAnsweredFromComments(db, iterationId);
  const rows = all<{
    id: string;
    question: string;
    posted_at: string | null;
    work_item_id: string;
    azure_id: number;
    title: string;
    parent_azure_id: number | null;
  }>(
    db,
    `SELECT q.id, q.question, q.posted_at, q.work_item_id, w.azure_id, w.title, p.azure_id AS parent_azure_id
     FROM questions q
     JOIN work_items w ON w.id = q.work_item_id
     LEFT JOIN work_items p ON p.id = w.parent_id
     WHERE w.iteration_id = ? AND q.id LIKE 'qfn-%' AND COALESCE(q.status, 'pending') = 'pending'
     ORDER BY w.azure_id, q.id`,
    iterationId
  );
  const groups = new Map<string, FunctionalQuestionGroup>();
  for (const row of rows) {
    let group = groups.get(row.work_item_id);
    if (!group) {
      group = {
        workItemId: row.work_item_id,
        azureId: row.azure_id,
        title: row.title,
        targetAzureId: row.parent_azure_id ?? row.azure_id,
        postedAt: row.posted_at,
        questions: [],
        copyText: ""
      };
      groups.set(row.work_item_id, group);
    }
    group.questions.push({ id: row.id, question: row.question });
    if (!group.postedAt || (row.posted_at && row.posted_at > group.postedAt)) group.postedAt = row.posted_at;
    if (!row.posted_at) group.postedAt = null;
  }
  return [...groups.values()].map((group) => ({
    ...group,
    copyText: functionalQuestionsCopy(
      group.azureId,
      group.title,
      group.questions.map((question) => question.question)
    )
  }));
}

export function answerFunctionalQuestion(db: Db, id: string): boolean {
  const row = get<{ id: string }>(db, "SELECT id FROM questions WHERE id = ? AND id LIKE 'qfn-%'", id);
  if (!row) return false;
  run(
    db,
    "UPDATE questions SET status = 'answered', answered_at = ? WHERE id = ?",
    nowIso(),
    id
  );
  return true;
}

export async function publishFunctionalQuestions(
  db: Db,
  config: AppConfig,
  workItemId: string,
  post: (azureId: number, text: string) => Promise<{ id: number; createdDate: string }>
): Promise<{ ok: true; azureId: number; copyText: string } | { ok: false; error: string }> {
  if (!config.azure.writes.enabled) {
    return { ok: false, error: "Escritura en Azure deshabilitada. Copiá el texto y pegalo en la historia." };
  }
  const group = listFunctionalQuestions(db, config.azure.iterationPath).find((item) => item.workItemId === workItemId);
  if (!group || !group.questions.length) return { ok: false, error: "No hay preguntas pendientes para publicar." };
  const unposted = all<{ id: string }>(
    db,
    "SELECT id FROM questions WHERE work_item_id = ? AND id LIKE 'qfn-%' AND COALESCE(status, 'pending') = 'pending' AND posted_at IS NULL",
    workItemId
  );
  if (!unposted.length) return { ok: false, error: "Esas preguntas ya están en la historia." };
  const posted = await post(group.targetAzureId, group.copyText);
  const postedAt = posted.createdDate || nowIso();
  const target = get<{ id: string }>(db, "SELECT id FROM work_items WHERE azure_id = ?", group.targetAzureId);
  if (target) {
    run(
      db,
      `INSERT INTO comments(id, work_item_id, author_id, author_name, created_at, text_html, source_revision)
       VALUES (?, ?, NULL, 'TL Control', ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET text_html = excluded.text_html`,
      `${target.id}/comment/${posted.id}`,
      target.id,
      postedAt,
      `<p>${escapeHtml(group.copyText)}</p>`
    );
  }
  for (const question of group.questions) {
    run(db, "UPDATE questions SET posted_at = ? WHERE id = ? AND posted_at IS NULL", postedAt, question.id);
  }
  return { ok: true, azureId: group.targetAzureId, copyText: group.copyText };
}

function settleAnsweredFromComments(db: Db, iterationId: string): void {
  const rows = all<{ id: string; work_item_id: string; posted_at: string }>(
    db,
    `SELECT q.id, q.work_item_id, q.posted_at
     FROM questions q
     JOIN work_items w ON w.id = q.work_item_id
     WHERE w.iteration_id = ? AND q.id LIKE 'qfn-%' AND COALESCE(q.status, 'pending') = 'pending' AND q.posted_at IS NOT NULL`,
    iterationId
  );
  const byItem = new Map<string, Array<{ id: string; posted_at: string }>>();
  for (const row of rows) {
    const list = byItem.get(row.work_item_id) ?? [];
    list.push(row);
    byItem.set(row.work_item_id, list);
  }
  for (const [workItemId, questions] of byItem) {
    const parent = get<{ parent_id: string | null }>(db, "SELECT parent_id FROM work_items WHERE id = ?", workItemId);
    const commentIds = [workItemId, parent?.parent_id].filter((id): id is string => Boolean(id));
    const comments = all<{ created_at: string | null; text_html: string | null }>(
      db,
      `SELECT created_at, text_html FROM comments WHERE work_item_id IN (${commentIds.map(() => "?").join(", ")})`,
      ...commentIds
    );
    for (const question of questions) {
      const answered = comments.some((comment) => {
        if (!comment.created_at || comment.created_at <= question.posted_at) return false;
        const text = `${comment.text_html ?? ""}\n${htmlToText(comment.text_html)}`;
        return !text.includes(FUNCTIONAL_QUESTION_MARKER);
      });
      if (!answered) continue;
      run(db, "UPDATE questions SET status = 'answered', answered_at = ? WHERE id = ?", nowIso(), question.id);
    }
  }
}

function questionId(workItemId: string, code: string): string {
  return `qfn-${workItemId.replaceAll("/", "-")}-${code}`;
}

function cleanRef(raw: string): string {
  return raw
    .split(/\s+pero\s+/i)[0]
    .replace(/[)\].,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\n", "<br>");
}
