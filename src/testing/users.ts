// Users for tests: `alice` owns what a test creates unless it says otherwise; `bob` is the other person.
import type { User, UserId } from "../auth/user.ts";

export const alice: User = { id: "user-alice" as UserId, name: "alice" };
export const bob: User = { id: "user-bob" as UserId, name: "bob" };
