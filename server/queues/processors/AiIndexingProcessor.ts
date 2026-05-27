import env from "@server/env";
import type { DocumentEvent, Event } from "@server/types";
import IndexDocumentTask from "../tasks/IndexDocumentTask";
import UnindexDocumentTask from "../tasks/UnindexDocumentTask";
import BaseProcessor from "./BaseProcessor";

export default class AiIndexingProcessor extends BaseProcessor {
  static applicableEvents: Event["name"][] = [
    "documents.publish",
    "documents.update.debounced",
    "documents.archive",
    "documents.unarchive",
    "documents.delete",
    "documents.permanent_delete",
    "documents.restore",
    "documents.title_change",
  ];

  async perform(event: DocumentEvent) {
    if (!env.AI_ANSWERS_ENABLED) {
      return;
    }

    switch (event.name) {
      case "documents.delete":
      case "documents.permanent_delete":
      case "documents.archive":
        await new UnindexDocumentTask().schedule({
          documentId: event.documentId,
        });
        break;

      default:
        await new IndexDocumentTask().schedule({
          documentId: event.documentId,
        });
    }
  }
}
