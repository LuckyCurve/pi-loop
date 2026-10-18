import { describe, expect, it } from "vitest";
import type { LoopRecord } from "../src/engine.ts";
import { type StatusRole, composeStatus } from "../src/status.ts";

const NOW = 1_000_000;

function loop(overrides: Partial<LoopRecord> = {}): LoopRecord {
	return {
		id: "l1",
		prompt: "check the deploy",
		intervalMs: 300_000,
		createdAt: NOW,
		runs: 0,
		skips: 0,
		consecutiveSkips: 0,
		nextAt: NOW + 150_000,
		...overrides,
	};
}

/** Records which role each run of text was painted with, so the roles are testable. */
function recorder(): { paint: (role: StatusRole, text: string) => string; roles: StatusRole[] } {
	const roles: StatusRole[] = [];
	return {
		roles,
		paint: (role, text) => {
			roles.push(role);
			return `<${role}>${text}</>`;
		},
	};
}

describe("composeStatus theming", () => {
	it("paints through the theme instead of using the terminal default", () => {
		// The footer sits on the transcript background. Left to the terminal default it is the
		// brightest text on the screen, which is why it has to be themed rather than passed through.
		const { paint } = recorder();
		const status = composeStatus([loop()], NOW, { paint });
		expect(status).toBe(
			"<accent>⟳</> <muted>LOOP Task 1</><dim> · </><dim>every 5m</><dim> · </><dim>next 2m30s</>",
		);
	});

	it("keeps every painted run inside a closing reset", () => {
		const { paint } = recorder();
		const status = composeStatus([loop({ runs: 2, skips: 1 })], NOW, { paint })!;
		// An unbalanced escape would bleed into the rest of the footer line.
		const opened = status.split("<").length - 1;
		const closed = status.split("</>").length - 1;
		expect(opened).toBe(closed * 2);
	});

	it("paints counters and extra-loop summaries too", () => {
		const { roles, paint } = recorder();
		composeStatus([loop({ runs: 3, skips: 2 }), loop({ id: "l2", paused: "agent" })], NOW, { paint });
		expect(roles).toContain("dim");
	});

	it("paints the paused-only line, which has no countdown", () => {
		const { paint } = recorder();
		const status = composeStatus([loop({ paused: "agent" })], NOW, { paint });
		expect(status).toBe("<muted>LOOP 1 paused</><dim> (agent)</>");
	});

	it("stays plain text when no theme is available", () => {
		// RPC mode has no theme object, and piping escape codes into a JSON status would be wrong.
		expect(composeStatus([loop()], NOW)).toBe("⟳ LOOP Task 1 · every 5m · next 2m30s");
	});
});
