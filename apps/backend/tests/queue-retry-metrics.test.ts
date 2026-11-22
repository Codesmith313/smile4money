import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  initializeQueue,
  listDlqEntries,
  processBatch,
  writeToDlq,
} from "../src/queue.js";

describe("DLQ retry attempt tracking", () => {
  const originalQueueStore = process.env.QUEUE_STORE;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    process.env.QUEUE_STORE = "memory";
    process.env.NODE_ENV = "test";
    await initializeQueue();
  });

  afterEach(() => {
    if (originalQueueStore === undefined) {
      delete process.env.QUEUE_STORE;
    } else {
      process.env.QUEUE_STORE = originalQueueStore;
    }

    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("persists attempts only for entries actually processed before batch failure", async () => {
    const first = await writeToDlq({ job: 1 }, "initial failure");
    const second = await writeToDlq({ job: 2 }, "initial failure");

    const result = await processBatch([first, second], async () => {
      throw new Error("retry failed");
    });

    expect(result.rolledBack).toBe(true);
    const entries = await listDlqEntries();
    expect(entries.map(({ id, attempts }) => [id, attempts])).toEqual([
      [first.id, 1],
      [second.id, 0],
    ]);
  });
});
