import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { Attachment, CreateTask, IdParams, Ok, Task, TaskDetail, UpdateTask } from "@hive/core";
import { requireUser, type RouteDeps } from "../context.ts";
import { notFound } from "../errors.ts";
import { INLINE_IMAGE_TYPES, MAX_FILE_BYTES } from "../../files/file-store.ts";

export const taskRoutes = (deps: RouteDeps): FastifyPluginAsyncTypebox => async (app) => {
  const { tasks } = deps.services;

  app.get("/tasks", { schema: { response: { 200: Type.Array(Task) } } }, async (req) => tasks.list(requireUser(req).orgId));
  app.get("/tasks/:id", { schema: { params: IdParams, response: { 200: TaskDetail } } }, async (req) => tasks.detail(requireUser(req).orgId, req.params.id));
  app.post("/tasks", { schema: { body: CreateTask, response: { 200: Task } } }, async (req) => tasks.create({ kind: "user", user: requireUser(req) }, req.body));
  app.patch("/tasks/:id", { schema: { params: IdParams, body: UpdateTask, response: { 200: Task } } }, async (req) => tasks.update(requireUser(req), req.params.id, req.body));
  app.post("/tasks/:id/approve", { schema: { params: IdParams, response: { 200: Task } } }, async (req) => tasks.approve(requireUser(req), req.params.id));
  app.delete("/tasks/:id", { schema: { params: IdParams, response: { 200: Ok } } }, async (req) => {
    tasks.remove(requireUser(req), req.params.id);
    return { ok: true as const };
  });
};

const FileParams = Type.Object({ id: Type.String({ pattern: "^file_[a-f0-9]{32}$" }) });

export const fileRoutes = (deps: RouteDeps): FastifyPluginAsyncTypebox => async (app) => {
  const { files, chat } = deps.services;

  // Uploads are raw bytes; the type is sniffed server-side, never taken from the client.
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: MAX_FILE_BYTES + 1024 }, (_req, body, done) => done(null, body));

  app.post("/channels/:id/files", { schema: { params: IdParams, response: { 200: Attachment } }, bodyLimit: MAX_FILE_BYTES + 1024 }, async (req) => {
    const user = requireUser(req);
    chat.channels.assertUserCanWrite(user, req.params.id);
    const raw = req.headers["x-filename"];
    let filename = "file";
    if (typeof raw === "string") {
      try {
        filename = decodeURIComponent(raw);
      } catch {
        filename = raw;
      }
    }
    const body = req.body as Buffer;
    return files.save({ kind: "user", id: user.id, orgId: user.orgId }, req.params.id, filename, new Uint8Array(body));
  });

  app.get("/channels/:id/files", { schema: { params: IdParams, response: { 200: Type.Array(Attachment) } } }, async (req) => {
    chat.channels.assertUserCanRead(requireUser(req), req.params.id);
    return files.listForChannel(req.params.id);
  });

  app.get("/files/:id", { schema: { params: FileParams, querystring: Type.Object({ inline: Type.Optional(Type.String()) }) } }, async (req, reply) => {
    const user = requireUser(req);
    const row = files.get(req.params.id);
    if (!row || row.orgId !== user.orgId) throw notFound("File");
    chat.channels.assertUserCanRead(user, row.channelId);
    const { data } = files.bytes(row.id);
    const inline = req.query.inline === "1" && INLINE_IMAGE_TYPES.has(row.mime);
    return reply
      .header("Content-Type", row.mime)
      .header("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.filename)}`)
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .header("Cache-Control", "private, max-age=3600")
      .send(data);
  });
};
