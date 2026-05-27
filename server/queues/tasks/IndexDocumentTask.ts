import env from "@server/env";
import Logger from "@server/logging/Logger";
import { indexDocument } from "@server/utils/aiIndexer";
import { BaseTask, TaskPriority } from "./base/BaseTask";

type Props = { documentId: string };

export default class IndexDocumentTask extends BaseTask<Props> {
  public async perform({ documentId }: Props) {
    if (!env.AI_ANSWERS_ENABLED) {
      return;
    }
    try {
      await indexDocument(documentId);
    } catch (err) {
      Logger.error(
        `Failed to index document ${documentId} for AI answers`,
        err as Error
      );
      throw err;
    }
  }

  public get options() {
    return { priority: TaskPriority.Background, attempts: 3 };
  }
}
