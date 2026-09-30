import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { EventBus, EventSourcingErrorCode, isEventSourcingError } from '@ocoda/event-sourcing';
import { Client, escapeIdentifier } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { BookRepository, BookSnapshotRepository } from '../src/catalogue/application/repositories/index.js';
import { AuthorId, BookId } from '../src/catalogue/domain/models/index.js';

/**
 * The PostgreSQL server of the database-backed specs (packages/testing/unit/db.ts): the `postgres` service of the
 * root docker-compose.yml unless ES_TEST_PG_* say otherwise. The application gets a schema of its own in that database,
 * which the spec recreates, so the global positions start at 1 and other specs' tables are left alone.
 */
const server = {
	host: process.env.ES_TEST_PG_HOST || '127.0.0.1',
	port: Number(process.env.ES_TEST_PG_PORT) || 5432,
	user: process.env.ES_TEST_PG_USER || 'postgres',
	password: process.env.ES_TEST_PG_PASSWORD || 'postgres',
	database: process.env.ES_TEST_PG_DATABASE || 'postgres',
};
const schema = 'example_e2e';

const databaseUrl = (): string => {
	const url = new URL(`postgres://${server.host}:${server.port}/${encodeURIComponent(server.database)}`);
	url.username = encodeURIComponent(server.user);
	url.password = encodeURIComponent(server.password);
	url.searchParams.set('options', `-c search_path=${schema}`);
	return url.toString();
};

const recreateSchema = async (): Promise<void> => {
	const client = new Client(server);
	await client.connect();
	try {
		await client.query(`DROP SCHEMA IF EXISTS ${escapeIdentifier(schema)} CASCADE`);
		await client.query(`CREATE SCHEMA ${escapeIdentifier(schema)}`);
	} finally {
		await client.end();
	}
};

const isbn = '978-0-13-468599-1';

describe('example application (e2e)', () => {
	let app: INestApplication;
	let baseUrl: string;

	const http = async (method: string, path: string, body?: unknown) => {
		const response = await fetch(`${baseUrl}${path}`, {
			method,
			headers: body === undefined ? undefined : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await response.text();
		return { status: response.status, body: text ? JSON.parse(text) : undefined };
	};

	const addBook = async (title: string, id?: string): Promise<string> => {
		const response = await http('POST', '/books', {
			id,
			title,
			authorIds: [randomUUID()],
			publicationDate: '2018-01-06',
			isbn,
		});
		expect(response.status).toBe(201);
		return response.body.id;
	};

	beforeAll(async () => {
		await recreateSchema();
		vi.stubEnv('DATABASE_URL', databaseUrl());

		app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
		await app.listen(0, '127.0.0.1');
		baseUrl = await app.getUrl();
	});

	afterAll(async () => {
		await app?.close();
		vi.unstubAllEnvs();
	});

	it('adds a book, changes it and reads it back', async () => {
		const id = await addBook('Effective Java');
		const coAuthor = randomUUID();

		expect((await http('PUT', `/books/${id}/authors/${coAuthor}`)).status).toBe(204);

		const { status, body: book } = await http('GET', `/books/${id}`);
		expect(status).toBe(200);
		expect(book).toMatchObject({
			id,
			title: 'Effective Java',
			isbn: '9780134685991',
			publicationDate: '2018-01-06T00:00:00.000Z',
			version: 2,
		});
		expect(book.authorIds).toHaveLength(2);
		expect(book.authorIds).toContain(coAuthor);

		expect((await http('DELETE', `/books/${id}/authors/${coAuthor}`)).status).toBe(204);
		expect((await http('GET', `/books/${id}`)).body).toMatchObject({ version: 3, authorIds: [book.authorIds[0]] });
	});

	it('lists the books once the subscribers have run', async () => {
		const kept = await addBook('Refactoring');
		const removed = await addBook('Legacy Code');
		expect((await http('DELETE', `/books/${removed}`, { reason: 'lost' })).status).toBe(204);

		// The subscribers that keep the list run after the commands resolved: wait for the bus instead of sleeping.
		await app.get(EventBus).whenIdle({ timeout: 5_000 });

		const { body: list } = await http('GET', '/books');
		expect(list).toContainEqual({ id: kept, title: 'Refactoring' });
		expect(list.map(({ id }: { id: string }) => id)).not.toContain(removed);
		expect((await http('GET', `/books/${removed}`)).status).toBe(404);
	});

	it('takes a snapshot every 5 versions and loads the book from it', async () => {
		const id = await addBook('Domain-Driven Design');
		const authors = Array.from({ length: 5 }, () => randomUUID());
		for (const author of authors) {
			expect((await http('PUT', `/books/${id}/authors/${author}`)).status).toBe(204);
		}

		// Version 6: the snapshot was taken when the book reached version 5, the last event is read from the stream.
		const snapshot = await app.get(BookSnapshotRepository).load(BookId.from(id));
		expect(snapshot.version).toBe(5);
		expect(snapshot.authorIds.map(({ value }) => value)).toEqual(expect.arrayContaining(authors.slice(0, 4)));

		const { body: book } = await http('GET', `/books/${id}`);
		expect(book).toMatchObject({ id, title: 'Domain-Driven Design', isbn: '9780134685991', version: 6 });
		expect(book.authorIds).toEqual(expect.arrayContaining(authors));
		expect(book.authorIds).toHaveLength(6);
	});

	it('answers 409 when a book with the same id already exists', async () => {
		const id = randomUUID();
		await addBook('Patterns of Enterprise Application Architecture', id);

		const { status, body } = await http('POST', '/books', {
			id,
			title: 'Another book',
			authorIds: [],
			publicationDate: '2002-11-05',
			isbn,
		});

		expect(status).toBe(409);
		expect(body).toMatchObject({ id, expectedVersion: 0, actualVersion: 1 });
		expect((await http('GET', `/books/${id}`)).body.title).toBe('Patterns of Enterprise Application Architecture');
	});

	it('rejects the save of a book that changed since it was loaded', async () => {
		const id = BookId.from(await addBook('Implementing Domain-Driven Design'));
		const repository = app.get(BookRepository);
		const load = async () => {
			const book = await repository.getById(id);
			if (!book) throw new Error(`book ${id.value} not found`);
			return book;
		};

		// Two writers load version 1 of the book, change it, and save it: the second one is too late.
		const first = await load();
		const second = await load();
		first.addAuthor(AuthorId.generate());
		second.addAuthor(AuthorId.generate());

		await repository.save(first);
		const error = await repository.save(second).catch((error: unknown) => error);

		expect(isEventSourcingError(error, EventSourcingErrorCode.EventStoreVersionConflict)).toBe(true);
		expect(error).toMatchObject({ expectedVersion: 1, actualVersion: 2 });
		expect((await http('GET', `/books/${id.value}`)).body.version).toBe(2);
	});

	it('lends a book, extends the loan and takes it back', async () => {
		const bookId = await addBook('The Pragmatic Programmer');
		const created = await http('POST', '/loans', {
			bookId,
			libraryMemberId: randomUUID(),
			dueOn: '2030-01-15T00:00:00.000Z',
		});
		expect(created.status).toBe(201);
		const loan = created.body.id;

		expect((await http('POST', `/loans/${loan}/extend`, { dueOn: '2030-02-15T00:00:00.000Z' })).status).toBe(204);
		expect((await http('POST', `/loans/${loan}/return`)).status).toBe(204);

		const { body } = await http('GET', `/loans/${loan}`);
		expect(body).toMatchObject({ id: loan, bookId, dueOn: '2030-02-15T00:00:00.000Z', version: 3 });
		expect(body.returnedOn).toEqual(expect.any(String));

		// A returned loan can't be extended.
		expect((await http('POST', `/loans/${loan}/extend`, { dueOn: '2030-03-15T00:00:00.000Z' })).status).toBe(409);
	});

	it('answers 404 for an unknown id and 400 for an invalid one', async () => {
		expect((await http('GET', `/books/${randomUUID()}`)).status).toBe(404);
		expect((await http('GET', '/books/not-a-uuid')).status).toBe(400);
		expect((await http('GET', `/loans/${randomUUID()}`)).status).toBe(404);
		expect(
			(await http('POST', '/books', { title: 'Bad', authorIds: [], publicationDate: '2020-01-01', isbn: '123' }))
				.status,
		).toBe(400);
	});

	// Runs last: it reads the events that the tests above stored.
	it('reads the event log in pages, in the order the events were stored', async () => {
		type Entry = { position: string; event: string; aggregateId: string; version: number };

		const first = await http('GET', '/events?limit=3');
		expect(first.status).toBe(200);
		expect(first.body.events.map(({ position }: Entry) => position)).toEqual(['1', '2', '3']);
		expect(first.body.events[0]).toMatchObject({ position: '1', event: 'book-added', version: 1 });
		expect(first.body.next).toBe('4');

		const all: Entry[] = [...first.body.events];
		let next: string = first.body.next;
		for (;;) {
			const page = await http('GET', `/events?from=${next}&limit=10`);
			if (page.body.events.length === 0) {
				expect(page.body.next).toBe(next);
				break;
			}
			all.push(...page.body.events);
			next = page.body.next;
		}

		// Every event of the spec, across all streams, at consecutive positions.
		expect(all.map(({ position }) => position)).toEqual(all.map((_, index) => String(index + 1)));
		expect(new Set(all.map(({ event }) => event))).toEqual(
			new Set([
				'book-added',
				'book-author-added',
				'book-author-removed',
				'book-removed',
				'book-loan-created',
				'book-loan-extended',
				'book-loan-returned',
			]),
		);

		expect((await http('GET', '/events?from=-1')).status).toBe(400);
	});
});
