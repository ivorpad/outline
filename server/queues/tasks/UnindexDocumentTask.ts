import env from "@server/env";
import Logger from "@server/logging/Logger";
import { deleteDocumentChunks } from "@server/utils/aiIndexer";
import { BaseTask, TaskPriority } from "./base/BaseTask";

type Props = { documentId: string };

export default class UnindexDocumentTask extends BaseTask<Props> {
  public async perform({ documentId }: Props) {
    if (!env.AI_ANSWERS_ENABLED) {
      return;
    }
    try {
      await deleteDocumentChunks(documentId);
    } catch (err) {
      Logger.error(
        `Failed to remove AI index for document ${documentId}`,
        err as Error
      );
      throw err;
    }
  }

  public get options() {
    return { priority: TaskPriority.Background, attempts: 3 };
  }
}
