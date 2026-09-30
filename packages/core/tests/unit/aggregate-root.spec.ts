import {
	Aggregate,
	AggregateRoot,
	Event,
	EventHandler,
	EventMap,
	EventSourcingErrorCode,
	EventStorePersistenceException,
	EventStoreVersionConflictException,
	EventStream,
	ExpectedVersion,
	type IEvent,
	InMemoryEventStore,
	MissingEventHandlerException,
	UUID,
	UncommittedEventsException,
	isEventSourcingError,
} from '@ocoda/event-sourcing';
import { createTestContext } from '@ocoda/event-sourcing-testing/unit';

@Event('aggregate-root-spec-credited')
class CreditedEvent implements IEvent {
	constructor(public readonly amount: number) {}
}

@Event('aggregate-root-spec-debited')
class DebitedEvent implements IEvent {
	constructor(public readonly amount: number) {}
}

@Event('aggregate-root-spec-unhandled')
class UnhandledEvent implements IEvent {}

class WalletId extends UUID {}

@Aggregate({ streamName: 'aggregate-root-spec-wallet' })
class Wallet extends AggregateRoot {
	public balance = 0;
	/** The version each handler saw, to prove the handler runs before the version moves. */
	public readonly versionsSeenByHandlers: number[] = [];

	credit(amount: number) {
		this.applyEvent(new CreditedEvent(amount));
	}

	debit(amount: number) {
		this.applyEvent(new DebitedEvent(amount));
	}

	@EventHandler(CreditedEvent)
	onCredited({ amount }: CreditedEvent) {
		this.versionsSeenByHandlers.push(this.version);
		this.balance += amount;
	}

	// A handler that throws, to prove that a failed handler leaves the version and the uncommitted events alone
	@EventHandler(DebitedEvent)
	onDebited({ amount }: DebitedEvent) {
		if (amount > this.balance) {
			throw new Error('Insufficient funds');
		}
		this.balance -= amount;
	}
}

@Aggregate({ streamName: 'aggregate-root-spec-lenient', missingHandler: 'ignore' })
class LenientWallet extends Wallet {}

@Aggregate({ streamName: 'aggregate-root-spec-strict', missingHandler: 'throw' })
class StrictWallet extends Wallet {}

@Event('aggregate-root-spec-opened')
class OpenedEvent implements IEvent {
	constructor(public readonly bonus: number) {}
}

// An event handler that applies an event: opening the wallet credits a bonus
@Aggregate({ streamName: 'aggregate-root-spec-bonus-wallet' })
class BonusWallet extends Wallet {
	open(bonus: number) {
		this.applyEvent(new OpenedEvent(bonus));
	}

	@EventHandler(OpenedEvent)
	onOpened({ bonus }: OpenedEvent) {
		this.versionsSeenByHandlers.push(this.version);
		this.applyEvent(new CreditedEvent(bonus));
	}
}

@Event('aggregate-root-spec-step')
class StepEvent implements IEvent {
	constructor(public readonly name: string) {}
}

/**
 * Each step applies the steps that `raises` lists for it from its handler, and the step named `failing` throws once
 * it has applied them. The log records each handler as `name@version`, with the version the handler saw.
 */
@Aggregate({ streamName: 'aggregate-root-spec-chain' })
class Chain extends AggregateRoot {
	public readonly log: string[] = [];

	constructor(
		private readonly raises: Record<string, string[]> = {},
		private readonly failing?: string,
	) {
		super();
	}

	step(name: string) {
		this.applyEvent(new StepEvent(name));
	}

	@EventHandler(StepEvent)
	onStep({ name }: StepEvent) {
		this.log.push(`${name}@${this.version}`);
		for (const next of this.raises[name] ?? []) {
			this.applyEvent(new StepEvent(next));
		}
		if (name === this.failing) {
			throw new Error(`${name} failed`);
		}
	}
}

const stepNames = (events: readonly IEvent[]): string[] => events.map((event) => (event as StepEvent).name);

async function* batches(...events: IEvent[][]): AsyncGenerator<IEvent[]> {
	for (const batch of events) {
		yield batch;
	}
}

describe(AggregateRoot, () => {
	describe('versions', () => {
		it('counts the uncommitted events on top of the committed version', () => {
			const wallet = new Wallet();
			expect(wallet.version).toBe(0);
			expect(wallet.committedVersion).toBe(0);

			wallet.credit(5);
			wallet.credit(3);

			expect(wallet.version).toBe(2);
			expect(wallet.committedVersion).toBe(0);
			expect(wallet.getUncommittedEvents()).toEqual([new CreditedEvent(5), new CreditedEvent(3)]);
			expect(wallet.balance).toBe(8);
		});

		it('hands out a copy of the uncommitted events', () => {
			const wallet = new Wallet();
			wallet.credit(5);

			const events = wallet.getUncommittedEvents() as IEvent[];
			events.length = 0;

			expect(wallet.getUncommittedEvents()).toEqual([new CreditedEvent(5)]);
			expect(wallet.getUncommittedEvents()).not.toBe(wallet.getUncommittedEvents());
			expectTypeOf(wallet.getUncommittedEvents()).toEqualTypeOf<readonly IEvent[]>();
		});

		it('moves the committed version up to the version when the events are marked as committed', () => {
			const wallet = new Wallet();
			wallet.credit(5);
			wallet.credit(3);

			wallet.markCommitted();

			expect(wallet.committedVersion).toBe(2);
			expect(wallet.version).toBe(2);
			expect(wallet.getUncommittedEvents()).toEqual([]);

			wallet.credit(1);
			expect(wallet.committedVersion).toBe(2);
			expect(wallet.version).toBe(3);
		});

		it('changes nothing when there is nothing to mark as committed', () => {
			const wallet = new Wallet();
			wallet.version = 7;

			wallet.markCommitted();

			expect(wallet.committedVersion).toBe(7);
			expect(wallet.version).toBe(7);
		});

		it('marks only the events it is given as committed, and keeps the events applied since', () => {
			const wallet = new Wallet();
			wallet.credit(5);
			wallet.credit(3);
			const events = wallet.getUncommittedEvents();
			wallet.credit(1);
			const [appliedSince] = wallet.getUncommittedEvents().slice(2);

			wallet.markCommitted(events);

			expect(wallet.committedVersion).toBe(2);
			expect(wallet.version).toBe(3);
			expect(wallet.getUncommittedEvents()).toEqual([new CreditedEvent(1)]);
			expect(wallet.getUncommittedEvents()[0]).toBe(appliedSince);

			wallet.markCommitted(wallet.getUncommittedEvents());
			expect(wallet.committedVersion).toBe(3);
			expect(wallet.getUncommittedEvents()).toEqual([]);

			wallet.markCommitted([]);
			expect(wallet.committedVersion).toBe(3);
		});

		it.each<[string, (events: readonly IEvent[]) => readonly IEvent[]]>([
			['equal copies of the events', () => [new CreditedEvent(5), new CreditedEvent(3)]],
			['the events in another order', (events) => [...events].reverse()],
			['events that are not the first', (events) => events.slice(1)],
			['more events than are uncommitted', (events) => [...events, new CreditedEvent(1)]],
			[
				'the events of another aggregate',
				() => {
					const other = new Wallet();
					other.credit(5);
					return other.getUncommittedEvents();
				},
			],
		])('refuses %s, and leaves the aggregate unchanged', (_, given) => {
			const wallet = new Wallet();
			wallet.credit(5);
			wallet.credit(3);
			const events = wallet.getUncommittedEvents();

			expect(() => wallet.markCommitted(given(events))).toThrow(
				new UncommittedEventsException({ aggregate: Wallet, operation: 'markCommitted', uncommittedEvents: 2 }),
			);
			expect(wallet.committedVersion).toBe(0);
			expect(wallet.version).toBe(2);
			expect(wallet.getUncommittedEvents()).toEqual(events);
		});

		it('refuses events that are already marked as committed', () => {
			const wallet = new Wallet();
			wallet.credit(5);
			const events = wallet.getUncommittedEvents();
			wallet.markCommitted(events);
			wallet.credit(3);

			expect(() => wallet.markCommitted(events)).toThrow(
				'Wallet has 1 uncommitted event(s), and the events given to markCommitted() are not the first of them: pass the events that getUncommittedEvents() returned, once they are appended.',
			);
			expect(wallet.committedVersion).toBe(1);
			expect(wallet.version).toBe(2);
		});

		it('sets the committed version, as a snapshot restore does', () => {
			const wallet = new Wallet();
			wallet.version = 10;

			expect(wallet.version).toBe(10);
			expect(wallet.committedVersion).toBe(10);

			wallet.credit(1);
			expect(wallet.version).toBe(11);
			expect(wallet.committedVersion).toBe(10);
		});

		it('refuses to set the version while events are uncommitted', () => {
			const wallet = new Wallet();
			wallet.credit(5);

			expect(() => {
				wallet.version = 10;
			}).toThrow(new UncommittedEventsException({ aggregate: Wallet, operation: 'version', uncommittedEvents: 1 }));
			expect(() => {
				wallet.version = 10;
			}).toThrow(
				'Wallet has 1 uncommitted event(s), so setting the version is not allowed: append them and call markCommitted() first.',
			);
			expect(wallet.version).toBe(1);
			expect(wallet.committedVersion).toBe(0);
		});
	});

	describe('applyEvent', () => {
		it('runs the handler before the version moves', () => {
			const wallet = new Wallet();
			wallet.credit(5);
			wallet.credit(3);

			expect(wallet.versionsSeenByHandlers).toEqual([0, 1]);
		});

		it('leaves the version and the uncommitted events unchanged when a handler throws', () => {
			const wallet = new Wallet();
			wallet.credit(5);

			expect(() => wallet.debit(10)).toThrow('Insufficient funds');

			expect(wallet.version).toBe(1);
			expect(wallet.committedVersion).toBe(0);
			expect(wallet.getUncommittedEvents()).toEqual([new CreditedEvent(5)]);
			expect(wallet.balance).toBe(5);

			// No drift: the next event gets the next version
			wallet.debit(5);
			expect(wallet.version).toBe(2);
			expect(wallet.getUncommittedEvents()).toEqual([new CreditedEvent(5), new DebitedEvent(5)]);
		});

		it('leaves the committed version unchanged when the handler of a history event throws', async () => {
			const wallet = new Wallet();

			await expect(wallet.loadFromHistory([new CreditedEvent(5), new DebitedEvent(10)])).rejects.toThrow(
				'Insufficient funds',
			);

			expect(wallet.committedVersion).toBe(1);
			expect(wallet.version).toBe(1);
			expect(wallet.getUncommittedEvents()).toEqual([]);
		});

		it('throws a MissingEventHandlerException for an event without a handler, and leaves the aggregate unchanged', () => {
			const wallet = new Wallet();
			wallet.credit(5);

			expect(() => wallet.applyEvent(new UnhandledEvent())).toThrow(
				new MissingEventHandlerException({ aggregate: Wallet, event: UnhandledEvent }),
			);
			expect(() => wallet.applyEvent(new UnhandledEvent(), true)).toThrow(UncommittedEventsException);
			expect(wallet.version).toBe(1);
			expect(wallet.getUncommittedEvents()).toEqual([new CreditedEvent(5)]);
		});

		it("throws for an event without a handler with missingHandler: 'throw'", () => {
			const wallet = new StrictWallet();

			expect(() => wallet.applyEvent(new UnhandledEvent())).toThrow(MissingEventHandlerException);
			expect(wallet.version).toBe(0);
		});

		it('throws for an event without a handler when the aggregate has no @Aggregate() metadata', () => {
			class UndecoratedWallet extends AggregateRoot {}
			const wallet = new UndecoratedWallet();

			expect(() => wallet.applyEvent(new UnhandledEvent())).toThrow(
				new MissingEventHandlerException({ aggregate: UndecoratedWallet, event: UnhandledEvent }),
			);
		});

		it("applies an event without a handler with missingHandler: 'ignore'", async () => {
			const wallet = new LenientWallet();

			wallet.applyEvent(new UnhandledEvent());
			wallet.credit(5);

			expect(wallet.version).toBe(2);
			expect(wallet.getUncommittedEvents()).toEqual([new UnhandledEvent(), new CreditedEvent(5)]);
			expect(wallet.balance).toBe(5);

			const loaded = new LenientWallet();
			await loaded.loadFromHistory([new UnhandledEvent(), new CreditedEvent(5), new UnhandledEvent()]);
			expect(loaded.committedVersion).toBe(3);
			expect(loaded.balance).toBe(5);
		});

		it('refuses an event from the history while events are uncommitted', () => {
			const wallet = new Wallet();
			wallet.credit(5);

			expect(() => wallet.applyEvent(new CreditedEvent(1), true)).toThrow(
				new UncommittedEventsException({ aggregate: Wallet, operation: 'applyEvent', uncommittedEvents: 1 }),
			);
			expect(wallet.balance).toBe(5);
			expect(wallet.version).toBe(1);
		});
	});

	describe('event handlers that apply events', () => {
		it('applies the event after the handler that applied it returns, and records it after that handler’s event', () => {
			const wallet = new BonusWallet();

			wallet.open(10);

			expect(wallet.getUncommittedEvents()).toEqual([new OpenedEvent(10), new CreditedEvent(10)]);
			expect(wallet.version).toBe(2);
			expect(wallet.balance).toBe(10);
			expect(wallet.versionsSeenByHandlers).toEqual([0, 1]);
		});

		it('applies them depth first, each after the handler of the event that applied it', () => {
			const chain = new Chain({ A: ['B1', 'B2'], B1: ['C'] });

			chain.step('A');
			chain.step('D');

			// The order 3.x recorded them in: A, then what A applied, each followed by what it applied
			expect(stepNames(chain.getUncommittedEvents())).toEqual(['A', 'B1', 'C', 'B2', 'D']);
			expect(chain.log).toEqual(['A@0', 'B1@1', 'C@2', 'B2@3', 'D@4']);
			expect(chain.version).toBe(5);
		});

		it('ignores the events that handlers apply while the history is applied, as the history holds them', async () => {
			const live = new Chain({ A: ['B1', 'B2'], B1: ['C'] });
			live.step('A');

			const loaded = new Chain({ A: ['B1', 'B2'], B1: ['C'] });
			await loaded.loadFromHistory(live.getUncommittedEvents());

			expect(loaded.log).toEqual(live.log);
			expect(loaded.committedVersion).toBe(4);
			expect(loaded.getUncommittedEvents()).toEqual([]);

			const applied = new Chain({ A: ['B'] });
			applied.applyEvent(new StepEvent('A'), true);
			expect(applied.log).toEqual(['A@0']);
			expect(applied.version).toBe(1);
			expect(applied.getUncommittedEvents()).toEqual([]);
		});

		it('discards the events a handler applied when that handler throws', () => {
			const chain = new Chain({ A: ['B'] }, 'A');

			expect(() => chain.step('A')).toThrow('A failed');

			expect(chain.log).toEqual(['A@0']);
			expect(chain.version).toBe(0);
			expect(chain.getUncommittedEvents()).toEqual([]);
		});

		it('keeps the events whose handlers returned when the handler of an applied event throws', () => {
			const chain = new Chain({ A: ['B', 'C'] }, 'B');

			expect(() => chain.step('A')).toThrow('B failed');

			expect(chain.log).toEqual(['A@0', 'B@1']);
			expect(stepNames(chain.getUncommittedEvents())).toEqual(['A']);
			expect(chain.version).toBe(1);

			// No drift, and nothing left over from the failed step
			chain.step('D');
			expect(stepNames(chain.getUncommittedEvents())).toEqual(['A', 'D']);
			expect(chain.log).toEqual(['A@0', 'B@1', 'D@1']);
		});

		it('records the events that handlers apply again once the history is applied', async () => {
			const chain = new Chain({ A: ['B'] });
			await chain.loadFromHistory([new StepEvent('A'), new StepEvent('B')]);

			chain.step('A');

			expect(stepNames(chain.getUncommittedEvents())).toEqual(['A', 'B']);
			expect(chain.log).toEqual(['A@0', 'B@1', 'A@2', 'B@3']);
			expect(chain.version).toBe(4);
		});
	});

	describe('loadFromHistory', () => {
		it('applies the batches of an async iterable as committed events', async () => {
			const wallet = new Wallet();

			await wallet.loadFromHistory(batches([new CreditedEvent(5), new CreditedEvent(3)], [new DebitedEvent(2)]));

			expect(wallet.balance).toBe(6);
			expect(wallet.version).toBe(3);
			expect(wallet.committedVersion).toBe(3);
			expect(wallet.getUncommittedEvents()).toEqual([]);
		});

		it('applies an array of events', async () => {
			const wallet = new Wallet();
			wallet.version = 4;

			await wallet.loadFromHistory([new CreditedEvent(5), new CreditedEvent(3)]);

			expect(wallet.balance).toBe(8);
			expect(wallet.committedVersion).toBe(6);
		});

		it('refuses to load while events are uncommitted, before it reads any event', async () => {
			const wallet = new Wallet();
			wallet.credit(5);
			const read = vi.fn();
			async function* history(): AsyncGenerator<IEvent[]> {
				read();
				yield [new CreditedEvent(1)];
			}

			await expect(wallet.loadFromHistory(history())).rejects.toThrow(
				new UncommittedEventsException({ aggregate: Wallet, operation: 'loadFromHistory', uncommittedEvents: 1 }),
			);
			expect(read).not.toHaveBeenCalled();
			expect(wallet.version).toBe(1);
			expect(wallet.committedVersion).toBe(0);
		});
	});

	describe('commit (deprecated)', () => {
		it('returns the uncommitted events and marks them as committed', () => {
			const wallet = new Wallet();
			wallet.credit(5);
			wallet.credit(3);

			expect(wallet.commit()).toEqual([new CreditedEvent(5), new CreditedEvent(3)]);
			expect(wallet.committedVersion).toBe(2);
			expect(wallet.version).toBe(2);
			expect(wallet.commit()).toEqual([]);
		});
	});

	describe('saving through an event store', () => {
		let eventStore: InMemoryEventStore;

		const eventMap = new EventMap();
		eventMap.registerSerializers([CreditedEvent, DebitedEvent, OpenedEvent]);

		const load = async <W extends Wallet = Wallet>(id: WalletId, wallet: W = new Wallet() as W): Promise<W> => {
			await wallet.loadFromHistory(eventStore.getEvents(EventStream.for(wallet.constructor as typeof Wallet, id)));
			return wallet;
		};

		// The repository pattern of the migration guide
		const save = async (id: WalletId, wallet: Wallet): Promise<void> => {
			const events = wallet.getUncommittedEvents();
			await eventStore.appendEvents(EventStream.for(wallet.constructor as typeof Wallet, id), events, {
				expectedVersion: wallet.committedVersion,
			});
			wallet.markCommitted(events);
		};

		beforeEach(async () => {
			eventStore = new InMemoryEventStore(createTestContext(eventMap), { driver: InMemoryEventStore });
			await eventStore.connect();
			await eventStore.ensureCollection();
		});

		it('appends the uncommitted events at the committed version, and loads them back', async () => {
			const id = WalletId.generate();
			const wallet = new Wallet();
			wallet.credit(5);
			wallet.credit(3);

			await save(id, wallet);
			expect(wallet.committedVersion).toBe(2);

			const loaded = await load(id);
			expect(loaded.balance).toBe(8);
			expect(loaded.version).toBe(2);

			loaded.debit(8);
			await save(id, loaded);
			expect((await load(id)).version).toBe(3);
		});

		it('appends nothing for an unchanged aggregate', async () => {
			const id = WalletId.generate();
			const wallet = new Wallet();
			wallet.credit(5);
			await save(id, wallet);

			const persistEvents = vi.spyOn(eventStore, 'persistEvents');
			const loaded = await load(id);
			await save(id, loaded);

			expect(persistEvents).not.toHaveBeenCalled();
			expect(loaded.version).toBe(1);
		});

		it('keeps the events of a failed append, so the save can be retried', async () => {
			const id = WalletId.generate();
			const wallet = new Wallet();
			wallet.credit(5);
			wallet.credit(3);
			vi.spyOn(eventStore, 'persistEvents').mockRejectedValueOnce(
				new EventStorePersistenceException({ collection: 'events', outcome: 'not-persisted' }),
			);

			await expect(save(id, wallet)).rejects.toThrow(EventStorePersistenceException);
			expect(wallet.committedVersion).toBe(0);
			expect(wallet.getUncommittedEvents()).toEqual([new CreditedEvent(5), new CreditedEvent(3)]);

			await save(id, wallet);

			expect(wallet.committedVersion).toBe(2);
			const loaded = await load(id);
			expect(loaded.balance).toBe(8);
			expect(loaded.version).toBe(2);
		});

		it('keeps the events of an append that conflicts, and the aggregate can be reloaded', async () => {
			const id = WalletId.generate();
			const first = new Wallet();
			first.credit(5);
			await save(id, first);

			const winner = await load(id);
			const loser = await load(id);
			winner.credit(1);
			loser.credit(2);
			await save(id, winner);

			const conflict = await save(id, loser).catch((error: unknown) => error);
			expect(conflict).toBeInstanceOf(EventStoreVersionConflictException);
			expect(
				isEventSourcingError(conflict, EventSourcingErrorCode.EventStoreVersionConflict) && conflict.actualVersion,
			).toBe(2);
			expect(loser.getUncommittedEvents()).toEqual([new CreditedEvent(2)]);
			expect(() => {
				loser.version = 2;
			}).toThrow(UncommittedEventsException);

			// Reload and replay the command
			const reloaded = await load(id);
			reloaded.credit(2);
			await save(id, reloaded);
			expect((await load(id)).balance).toBe(8);
		});

		it('loads an aggregate whose event handler applies an event into the state it was saved with', async () => {
			const id = WalletId.generate();
			const wallet = new BonusWallet();
			wallet.open(10);
			wallet.credit(5);
			await save(id, wallet);

			const loaded = await load(id, new BonusWallet());

			expect(loaded.balance).toBe(15);
			expect(loaded.version).toBe(3);
			expect(loaded.versionsSeenByHandlers).toEqual(wallet.versionsSeenByHandlers);
			expect(loaded.getUncommittedEvents()).toEqual([]);

			const persistEvents = vi.spyOn(eventStore, 'persistEvents');
			await save(id, loaded);
			expect(persistEvents).not.toHaveBeenCalled();
		});

		it('keeps an event applied while the append runs, when markCommitted() is given the appended events', async () => {
			const id = WalletId.generate();
			const wallet = new Wallet();
			wallet.credit(5);

			const events = wallet.getUncommittedEvents();
			const append = eventStore.appendEvents(EventStream.for(Wallet, id), events, {
				expectedVersion: wallet.committedVersion,
			});
			wallet.credit(3);
			await append;
			wallet.markCommitted(events);

			expect(wallet.committedVersion).toBe(1);
			expect(wallet.getUncommittedEvents()).toEqual([new CreditedEvent(3)]);

			await save(id, wallet);
			const loaded = await load(id);
			expect(loaded.balance).toBe(8);
			expect(loaded.version).toBe(2);
		});

		it('drops an event applied while the append runs, when markCommitted() is called without events', async () => {
			const id = WalletId.generate();
			const wallet = new Wallet();
			wallet.credit(5);

			const events = wallet.getUncommittedEvents();
			const append = eventStore.appendEvents(EventStream.for(Wallet, id), events, {
				expectedVersion: wallet.committedVersion,
			});
			wallet.credit(3);
			await append;
			wallet.markCommitted();

			// It counts as committed, but the stream only has the first event
			expect(wallet.committedVersion).toBe(2);
			expect(wallet.getUncommittedEvents()).toEqual([]);
			await expect(eventStore.getStreamVersion(EventStream.for(Wallet, id))).resolves.toBe(1);
		});

		it('loses the events of a failed append with the deprecated commit()', async () => {
			const id = WalletId.generate();
			const wallet = new Wallet();
			wallet.credit(5);
			vi.spyOn(eventStore, 'persistEvents').mockRejectedValueOnce(
				new EventStorePersistenceException({ collection: 'events', outcome: 'not-persisted' }),
			);

			const events = wallet.commit();
			await expect(
				eventStore.appendEvents(EventStream.for(Wallet, id), events, {
					expectedVersion: wallet.version - events.length,
				}),
			).rejects.toThrow(EventStorePersistenceException);

			expect(wallet.getUncommittedEvents()).toEqual([]);
			expect(wallet.committedVersion).toBe(1);
			await expect(eventStore.getStreamVersion(EventStream.for(Wallet, id))).resolves.toBe(ExpectedVersion.NoStream);
		});
	});

	it('keeps its bookkeeping out of the string keys and the JSON of the aggregate', () => {
		const wallet = new Wallet();
		wallet.credit(5);
		wallet.markCommitted();
		wallet.credit(1);

		expect(Object.keys(wallet)).toEqual(['balance', 'versionsSeenByHandlers']);
		expect(JSON.parse(JSON.stringify(wallet))).toEqual({ balance: 6, versionsSeenByHandlers: [0, 1] });
	});
});
