const { default: Anthropic } = require("@anthropic-ai/sdk");
const { readFileSync, writeFileSync } = require("node:fs");

const apiKey = process.env.ANTHROPIC_API_KEY;

if (!apiKey) {
	throw new Error("ANTHROPIC_API_KEY is required to generate release notes.");
}

const client = new Anthropic({ apiKey });
const changesets = readFileSync("/tmp/changesets.txt", "utf-8");
const commits = readFileSync("/tmp/commits.txt", "utf-8");

const prompt = `You are generating release notes for @ocoda/event-sourcing, a NestJS event sourcing library.

Based on the following changesets and commits, generate user-friendly release notes in markdown format.

**Changesets:**
${changesets}

**Recent Commits:**
${commits}

**Guidelines:**
1. Group changes into categories: Features, Bug Fixes, Performance, Documentation, Breaking Changes
2. Write from the user's perspective (what they can do now, what's fixed for them)
3. Include migration notes for any breaking changes
4. Keep descriptions concise but informative
5. Link to relevant documentation where helpful
6. Use present tense ("Adds support for..." not "Added support for...")

Generate the release notes now:`;

const response = client.messages.create({
	model: "claude-3-5-sonnet-20240620",
	max_tokens: 2000,
	messages: [{ role: "user", content: prompt }]
});

Promise.resolve(response)
	.then((result) => result.content?.[0]?.text?.trim())
	.then((notes) => {
		if (!notes) {
			throw new Error("AI response did not include release notes content.");
		}

		writeFileSync("/tmp/release-notes.md", `${notes}\n`);
	})
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
