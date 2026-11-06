import { getCurrentUser } from "@/server/auth/dal";
import { db } from "@/server/db/client";
import { isSameOriginRequest, jsonError } from "@/server/http/origin";
import { enqueueIngest } from "@/server/jobs/enqueue";
import { ExtractionError, extractFile, UPLOAD_LIMITS } from "@/server/knowledge/extract";
import { addFileSource, KnowledgeError } from "@/server/knowledge/service";
import { authorizeOrg } from "@/server/orgs/service";

/**
 * File upload: authenticate, authorize (admin), enforce size before reading, validate type by extension AND
 * signature, extract text in-process, store only the normalized text. The original file is not retained.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/orgs/[orgSlug]/agents/[agentSlug]/knowledge/files">) {
  if (!isSameOriginRequest(request)) return jsonError(403, "bad_origin", "Request origin not allowed");
  const user = await getCurrentUser();
  if (!user) return jsonError(401, "unauthenticated", "Please sign in again.");
  const { orgSlug, agentSlug } = await ctx.params;
  const scope = await authorizeOrg(db(), user.userId, orgSlug, "admin");
  if (!scope) return jsonError(404, "not_found", "Agent not found.");

  const declared = Number(request.headers.get("content-length") ?? "NaN");
  if (!Number.isFinite(declared) || declared > UPLOAD_LIMITS.maxBytes + 64 * 1024) {
    return jsonError(413, "too_large", "Files can be up to 4 MB.");
  }

  let file: File | null = null;
  try {
    const form = await request.formData();
    const value = form.get("file");
    file = value instanceof File ? value : null;
  } catch {
    return jsonError(400, "bad_request", "Couldn't read the upload.");
  }
  if (!file) return jsonError(400, "bad_request", "Choose a file to upload.");
  if (file.size > UPLOAD_LIMITS.maxBytes) return jsonError(413, "too_large", "Files can be up to 4 MB.");

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const extracted = await extractFile(file.name, bytes);
    const ticket = await addFileSource(db(), scope, agentSlug, { name: file.name, mime: file.type || "application/octet-stream", size: file.size, extracted });
    const queued = await enqueueIngest(ticket);
    return Response.json(
      { ok: true, queued, truncated: extracted.truncated },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ExtractionError) return jsonError(422, error.code, error.message);
    if (error instanceof KnowledgeError) return jsonError(error.code === "forbidden" ? 403 : error.code === "not_found" ? 404 : 400, error.code, error.message);
    console.error("[upload] unexpected error", error instanceof Error ? error.name : "unknown");
    return jsonError(500, "internal_error", "Upload failed. Please try again.");
  }
}
