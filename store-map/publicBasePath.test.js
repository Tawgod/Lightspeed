const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizePublicBasePath, stripPublicBasePath } = require("./publicBasePath");

test("Store Map base path preserves root and strips only the configured prefix", () => {
  assert.equal(normalizePublicBasePath("/hobby-corner/store-map/"), "/hobby-corner/store-map");
  assert.equal(stripPublicBasePath("/hobby-corner/store-map/?x=1", "/hobby-corner/store-map"), "/?x=1");
  assert.equal(stripPublicBasePath("/hobby-corner/store-map/health", "/hobby-corner/store-map"), "/health");
  assert.equal(stripPublicBasePath("/health", "/hobby-corner/store-map"), "/health");
  assert.throws(() => normalizePublicBasePath("../store-map"));
  assert.throws(() => normalizePublicBasePath("/store-map?unsafe=1"));
});
