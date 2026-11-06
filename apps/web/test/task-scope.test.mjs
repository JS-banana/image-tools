import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TaskScope } from "../shared/task-scope.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("image task ownership", () => {
  it("a slower first decode cannot overwrite the image selected afterwards", async () => {
    const scope = new TaskScope();
    const first = deferred();
    const second = deferred();
    const displayed = [];
    const decode = async (source) => {
      const ticket = scope.next();
      const image = await source.promise;
      if (ticket.isCurrent()) displayed.push(image);
    };
    const pendingFirst = decode(first);
    const pendingSecond = decode(second);
    second.resolve("B");
    await pendingSecond;
    first.resolve("A");
    await pendingFirst;
    assert.deepEqual(displayed, ["B"]);
  });

  it("changing the input invalidates old inference progress, success and failure", async () => {
    const scope = new TaskScope();
    const inference = deferred();
    const ticket = scope.capture();
    const events = [];
    const publish = (event) => {
      if (ticket.isCurrent()) events.push(event);
    };
    const pending = inference.promise.then(
      () => publish("result A"),
      () => publish("error A"),
    );
    scope.invalidate();
    publish("progress A");
    inference.reject(new Error("old image failed"));
    await pending;
    assert.deepEqual(events, []);
  });

  it("clear/unmount invalidate pending work without reviving it on a new lifecycle", async () => {
    const scope = new TaskScope();
    const oldWork = deferred();
    const oldTicket = scope.next();
    const events = [];
    const pending = oldWork.promise.then(() => {
      if (oldTicket.isCurrent()) events.push("old result");
    });
    scope.invalidate();
    const newTicket = scope.next();
    oldWork.resolve();
    await pending;
    assert.deepEqual(events, []);
    assert.equal(newTicket.isCurrent(), true);
  });
});
