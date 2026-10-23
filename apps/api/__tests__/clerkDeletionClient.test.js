"use strict";
const mockDeleteUser = jest.fn();
jest.mock("@clerk/backend", () => ({ createClerkClient: () => ({ users: { deleteUser: mockDeleteUser } }) }));
const { buildClerkClient, noopClerkClient } = require("../src/services/clerkClient");
afterEach(() => mockDeleteUser.mockReset());
test("provider deletion treats an already-deleted identity as success", async () => {
  const client = buildClerkClient({ secretKey: "fixture" });
  mockDeleteUser.mockRejectedValueOnce({ status: 404 });
  await expect(client.deleteUser("deleted-owner")).resolves.toBeUndefined();
  expect(mockDeleteUser).toHaveBeenCalledWith("deleted-owner");
});
test("provider outage stays retryable, including an unavailable SDK", async () => {
  const client = buildClerkClient({ secretKey: "fixture" });
  mockDeleteUser.mockRejectedValueOnce({ status: 503 });
  await expect(client.deleteUser("pending-owner")).rejects.toEqual({ status: 503 });
  await expect(noopClerkClient().deleteUser("pending-owner")).rejects.toMatchObject({ code: "clerk_unavailable" });
});
