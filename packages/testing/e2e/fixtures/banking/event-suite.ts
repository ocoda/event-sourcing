import {
	Aggregate,
	AggregateRoot,
	DefaultEventSerializer,
	Event,
	EventEnvelope,
	EventId,
	EventMap,
	EventStream,
	type IEvent,
	UUID,
} from '@ocoda/event-sourcing';

const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);

@Aggregate({ streamName: 'customer' })
class CustomerAggregate extends AggregateRoot {}

@Aggregate({ streamName: 'account' })
class AccountAggregate extends AggregateRoot {}

@Aggregate({ streamName: 'card' })
class CardAggregate extends AggregateRoot {}

@Aggregate({ streamName: 'transfer' })
class TransferAggregate extends AggregateRoot {}

@Aggregate({ streamName: 'dispute' })
class DisputeAggregate extends AggregateRoot {}

@Aggregate({ streamName: 'compliance-review' })
class ComplianceReviewAggregate extends AggregateRoot {}

@Event('customer-registered')
export class CustomerRegisteredEvent implements IEvent {
	constructor(
		public readonly customerId: string,
		public readonly email: string,
		public readonly country: string,
	) {}
}

@Event('customer-address-updated')
export class CustomerAddressUpdatedEvent implements IEvent {
	constructor(
		public readonly line1: string,
		public readonly city: string,
		public readonly country: string,
	) {}
}

@Event('customer-contact-updated')
export class CustomerContactUpdatedEvent implements IEvent {
	constructor(public readonly phone: string) {}
}

@Event('customer-kyc-submitted')
export class CustomerKycSubmittedEvent implements IEvent {
	constructor(
		public readonly provider: string,
		public readonly submittedAt: string,
	) {}
}

@Event('sanctions-screened')
export class SanctionsScreenedEvent implements IEvent {
	constructor(
		public readonly provider: string,
		public readonly result: 'clear' | 'possible-match',
	) {}
}

@Event('customer-kyc-approved')
export class CustomerKycApprovedEvent implements IEvent {
	constructor(
		public readonly level: 'standard' | 'enhanced',
		public readonly approvedBy: string,
	) {}
}

@Event('customer-risk-flagged')
export class CustomerRiskFlaggedEvent implements IEvent {
	constructor(
		public readonly reason: string,
		public readonly score: number,
	) {}
}

@Event('customer-risk-cleared')
export class CustomerRiskClearedEvent implements IEvent {
	constructor(
		public readonly clearedBy: string,
		public readonly clearedAt: string,
	) {}
}

@Event('account-opened')
export class AccountOpenedEvent implements IEvent {
	constructor(
		public readonly accountId: string,
		public readonly ownerId: string,
		public readonly accountType: 'checking' | 'savings',
		public readonly currency: string,
	) {}
}

@Event('account-owner-added')
export class AccountOwnerAddedEvent implements IEvent {
	constructor(public readonly ownerId: string) {}
}

@Event('account-limit-changed')
export class AccountLimitChangedEvent implements IEvent {
	constructor(
		public readonly dailyLimit: number,
		public readonly monthlyLimit: number,
	) {}
}

@Event('account-overdraft-enabled')
export class AccountOverdraftEnabledEvent implements IEvent {
	constructor(public readonly limit: number) {}
}

@Event('account-deposit-received')
export class AccountDepositReceivedEvent implements IEvent {
	constructor(
		public readonly amount: number,
		public readonly currency: string,
		public readonly reference: string,
	) {}
}

@Event('account-withdrawal-requested')
export class AccountWithdrawalRequestedEvent implements IEvent {
	constructor(
		public readonly amount: number,
		public readonly channel: 'atm' | 'transfer' | 'bill-pay',
	) {}
}

@Event('account-withdrawal-completed')
export class AccountWithdrawalCompletedEvent implements IEvent {
	constructor(
		public readonly amount: number,
		public readonly channel: 'atm' | 'transfer' | 'bill-pay',
		public readonly reference: string,
	) {}
}

@Event('account-fee-applied')
export class AccountFeeAppliedEvent implements IEvent {
	constructor(
		public readonly feeType: 'atm' | 'overdraft' | 'maintenance' | 'chargeback',
		public readonly amount: number,
	) {}
}

@Event('account-interest-accrued')
export class AccountInterestAccruedEvent implements IEvent {
	constructor(
		public readonly amount: number,
		public readonly period: string,
	) {}
}

@Event('account-interest-applied')
export class AccountInterestAppliedEvent implements IEvent {
	constructor(
		public readonly amount: number,
		public readonly balanceAfter: number,
	) {}
}

@Event('account-overdraft-incurred')
export class AccountOverdraftIncurredEvent implements IEvent {
	constructor(
		public readonly amount: number,
		public readonly balanceAfter: number,
	) {}
}

@Event('account-overdraft-repaid')
export class AccountOverdraftRepaidEvent implements IEvent {
	constructor(
		public readonly amount: number,
		public readonly balanceAfter: number,
	) {}
}

@Event('account-frozen')
export class AccountFrozenEvent implements IEvent {
	constructor(public readonly reason: string) {}
}

@Event('account-unfrozen')
export class AccountUnfrozenEvent implements IEvent {
	constructor(public readonly reason: string) {}
}

@Event('account-closed')
export class AccountClosedEvent implements IEvent {
	constructor(public readonly reason: string) {}
}

@Event('transfer-initiated')
export class TransferInitiatedEvent implements IEvent {
	constructor(
		public readonly transferId: string,
		public readonly fromAccountId: string,
		public readonly toAccountId: string,
		public readonly amount: number,
		public readonly currency: string,
		public readonly rail: 'internal' | 'ach' | 'sepa',
	) {}
}

@Event('transfer-authorized')
export class TransferAuthorizedEvent implements IEvent {
	constructor(
		public readonly authorizedBy: string,
		public readonly method: 'otp' | 'biometric' | 'system',
	) {}
}

@Event('transfer-settled')
export class TransferSettledEvent implements IEvent {
	constructor(public readonly settledAt: string) {}
}

@Event('transfer-failed')
export class TransferFailedEvent implements IEvent {
	constructor(public readonly reason: string) {}
}

@Event('transfer-reversed')
export class TransferReversedEvent implements IEvent {
	constructor(public readonly reason: string) {}
}

@Event('card-issued')
export class CardIssuedEvent implements IEvent {
	constructor(
		public readonly cardId: string,
		public readonly accountId: string,
		public readonly last4: string,
		public readonly network: 'visa' | 'mastercard',
	) {}
}

@Event('card-activated')
export class CardActivatedEvent implements IEvent {
	constructor(public readonly channel: 'app' | 'ivr' | 'branch') {}
}

@Event('card-auth-requested')
export class CardAuthRequestedEvent implements IEvent {
	constructor(
		public readonly merchant: string,
		public readonly amount: number,
		public readonly currency: string,
		public readonly mcc: string,
	) {}
}

@Event('card-auth-approved')
export class CardAuthApprovedEvent implements IEvent {
	constructor(public readonly approvalCode: string) {}
}

@Event('card-auth-declined')
export class CardAuthDeclinedEvent implements IEvent {
	constructor(public readonly reason: string) {}
}

@Event('card-capture')
export class CardCaptureEvent implements IEvent {
	constructor(
		public readonly amount: number,
		public readonly captureId: string,
	) {}
}

@Event('card-refund-initiated')
export class CardRefundInitiatedEvent implements IEvent {
	constructor(
		public readonly amount: number,
		public readonly reason: string,
	) {}
}

@Event('card-refund-settled')
export class CardRefundSettledEvent implements IEvent {
	constructor(
		public readonly amount: number,
		public readonly settledAt: string,
	) {}
}

@Event('dispute-opened')
export class DisputeOpenedEvent implements IEvent {
	constructor(
		public readonly disputeId: string,
		public readonly transactionId: string,
		public readonly reason: string,
	) {}
}

@Event('dispute-evidence-submitted')
export class DisputeEvidenceSubmittedEvent implements IEvent {
	constructor(
		public readonly submittedBy: string,
		public readonly attachmentsCount: number,
	) {}
}

@Event('chargeback-issued')
export class ChargebackIssuedEvent implements IEvent {
	constructor(
		public readonly amount: number,
		public readonly reasonCode: string,
	) {}
}

@Event('dispute-closed')
export class DisputeClosedEvent implements IEvent {
	constructor(public readonly outcome: 'won' | 'lost' | 'partial') {}
}

@Event('fraud-hold-placed')
export class FraudHoldPlacedEvent implements IEvent {
	constructor(public readonly reason: string) {}
}

@Event('fraud-hold-released')
export class FraudHoldReleasedEvent implements IEvent {
	constructor(public readonly resolution: string) {}
}

@Event('compliance-review-opened')
export class ComplianceReviewOpenedEvent implements IEvent {
	constructor(
		public readonly reviewId: string,
		public readonly trigger: string,
	) {}
}

@Event('compliance-review-resolved')
export class ComplianceReviewResolvedEvent implements IEvent {
	constructor(
		public readonly reviewId: string,
		public readonly outcome: 'approved' | 'rejected',
	) {}
}

export const BankingEventClasses: Array<new (...args: any[]) => IEvent> = [
	CustomerRegisteredEvent,
	CustomerAddressUpdatedEvent,
	CustomerContactUpdatedEvent,
	CustomerKycSubmittedEvent,
	SanctionsScreenedEvent,
	CustomerKycApprovedEvent,
	CustomerRiskFlaggedEvent,
	CustomerRiskClearedEvent,
	AccountOpenedEvent,
	AccountOwnerAddedEvent,
	AccountLimitChangedEvent,
	AccountOverdraftEnabledEvent,
	AccountDepositReceivedEvent,
	AccountWithdrawalRequestedEvent,
	AccountWithdrawalCompletedEvent,
	AccountFeeAppliedEvent,
	AccountInterestAccruedEvent,
	AccountInterestAppliedEvent,
	AccountOverdraftIncurredEvent,
	AccountOverdraftRepaidEvent,
	AccountFrozenEvent,
	AccountUnfrozenEvent,
	AccountClosedEvent,
	TransferInitiatedEvent,
	TransferAuthorizedEvent,
	TransferSettledEvent,
	TransferFailedEvent,
	TransferReversedEvent,
	CardIssuedEvent,
	CardActivatedEvent,
	CardAuthRequestedEvent,
	CardAuthApprovedEvent,
	CardAuthDeclinedEvent,
	CardCaptureEvent,
	CardRefundInitiatedEvent,
	CardRefundSettledEvent,
	DisputeOpenedEvent,
	DisputeEvidenceSubmittedEvent,
	ChargebackIssuedEvent,
	DisputeClosedEvent,
	FraudHoldPlacedEvent,
	FraudHoldReleasedEvent,
	ComplianceReviewOpenedEvent,
	ComplianceReviewResolvedEvent,
];

export interface BankingScenarioStream {
	name: string;
	aggregateId: string;
	streamId: string;
	events: EventEnvelope[];
}

export interface BankingScenario {
	name: string;
	streams: BankingScenarioStream[];
	allEvents: EventEnvelope[];
	eventMap: EventMap;
}

export const createBankingEventMap = (): EventMap => {
	const eventMap = new EventMap();
	for (const event of BankingEventClasses) {
		eventMap.register(event, DefaultEventSerializer.for(event));
	}
	return eventMap;
};

const createEventEnvelopes = (options: {
	eventMap: EventMap;
	aggregateId: string;
	events: IEvent[];
	startDate: Date;
	correlationId?: string;
}): EventEnvelope[] => {
	const { eventMap, aggregateId, events, startDate, correlationId } = options;
	const eventIdFactory = EventId.factory();
	return events.map((event, index) => {
		const eventId = eventIdFactory(addMinutes(startDate, index * 6));
		return EventEnvelope.create(eventMap.getName(event), eventMap.serializeEvent(event), {
			aggregateId,
			version: index + 1,
			eventId,
			correlationId,
		});
	});
};

export const createBankingProductionScenario = (): BankingScenario => {
	const eventMap = createBankingEventMap();

	const customerId = UUID.generate();
	const primaryAccountId = UUID.generate();
	const savingsAccountId = UUID.generate();
	const cardId = UUID.generate();
	const transferId = UUID.generate();
	const transfer2Id = UUID.generate();
	const disputeId = UUID.generate();
	const complianceReviewId = UUID.generate();

	const baseDate = new Date('2024-05-06T08:15:00Z');
	const transferCorrelationId = EventId.generate(addMinutes(baseDate, 90)).value;
	const transfer2CorrelationId = EventId.generate(addMinutes(baseDate, 420)).value;
	const disputeCorrelationId = EventId.generate(addMinutes(baseDate, 860)).value;

	const customerEvents: IEvent[] = [
		new CustomerRegisteredEvent(customerId.value, 'jane.doe@finbank.example', 'US'),
		new CustomerAddressUpdatedEvent('100 Market Street', 'San Francisco', 'US'),
		new CustomerContactUpdatedEvent('+1-415-555-0199'),
		new CustomerKycSubmittedEvent('veriff', addMinutes(baseDate, 15).toISOString()),
		new SanctionsScreenedEvent('dowjones', 'clear'),
		new CustomerKycApprovedEvent('standard', 'ops-analyst-14'),
		new CustomerRiskFlaggedEvent('device-mismatch', 72),
		new CustomerRiskClearedEvent('risk-team-2', addMinutes(baseDate, 180).toISOString()),
	];

	const primaryAccountEvents: IEvent[] = [
		new AccountOpenedEvent(primaryAccountId.value, customerId.value, 'checking', 'USD'),
		new AccountOwnerAddedEvent('owner-joint-132'),
		new AccountLimitChangedEvent(3500, 25000),
		new AccountDepositReceivedEvent(3200, 'USD', 'payroll-05-15'),
		new AccountDepositReceivedEvent(220, 'USD', 'cash-deposit-branch-3'),
		new AccountWithdrawalRequestedEvent(120, 'atm'),
		new AccountWithdrawalCompletedEvent(120, 'atm', 'atm-0441'),
		new AccountFeeAppliedEvent('atm', 2.5),
		new AccountWithdrawalRequestedEvent(950, 'bill-pay'),
		new AccountWithdrawalCompletedEvent(950, 'bill-pay', 'rent-jun'),
		new AccountOverdraftEnabledEvent(500),
		new AccountWithdrawalRequestedEvent(2600, 'transfer'),
		new AccountWithdrawalCompletedEvent(2600, 'transfer', 'transfer-out-771'),
		new AccountOverdraftIncurredEvent(140, -140),
		new AccountFeeAppliedEvent('overdraft', 35),
		new AccountDepositReceivedEvent(550, 'USD', 'refund-merchant-881'),
		new AccountOverdraftRepaidEvent(175, 235),
		new AccountInterestAccruedEvent(3.45, '2024-05'),
		new AccountInterestAppliedEvent(3.45, 238.45),
		new FraudHoldPlacedEvent('velocity-alert'),
		new AccountFrozenEvent('fraud-hold'),
		new FraudHoldReleasedEvent('customer-verified'),
		new AccountUnfrozenEvent('fraud-cleared'),
		new AccountDepositReceivedEvent(1800, 'USD', 'payroll-06-15'),
		new AccountFeeAppliedEvent('maintenance', 12),
	];

	const savingsAccountEvents: IEvent[] = [
		new AccountOpenedEvent(savingsAccountId.value, customerId.value, 'savings', 'USD'),
		new AccountLimitChangedEvent(1000, 8000),
		new AccountDepositReceivedEvent(1500, 'USD', 'initial-transfer'),
		new AccountInterestAccruedEvent(2.1, '2024-05'),
		new AccountInterestAppliedEvent(2.1, 1502.1),
		new AccountDepositReceivedEvent(600, 'USD', 'bonus-deposit'),
		new AccountInterestAccruedEvent(2.8, '2024-06'),
		new AccountInterestAppliedEvent(2.8, 2104.9),
		new AccountWithdrawalRequestedEvent(250, 'transfer'),
		new AccountWithdrawalCompletedEvent(250, 'transfer', 'transfer-out-992'),
		new AccountDepositReceivedEvent(300, 'USD', 'transfer-in-550'),
		new AccountInterestAccruedEvent(3.05, '2024-07'),
		new AccountInterestAppliedEvent(3.05, 2157.95),
		new AccountWithdrawalRequestedEvent(500, 'transfer'),
		new AccountWithdrawalCompletedEvent(500, 'transfer', 'transfer-out-1101'),
	];

	const transferEvents: IEvent[] = [
		new TransferInitiatedEvent(
			transferId.value,
			primaryAccountId.value,
			savingsAccountId.value,
			600,
			'USD',
			'internal',
		),
		new TransferAuthorizedEvent('system', 'system'),
		new TransferSettledEvent(addMinutes(baseDate, 120).toISOString()),
		new TransferInitiatedEvent(transfer2Id.value, primaryAccountId.value, 'supplier-external-8841', 950, 'USD', 'ach'),
		new TransferAuthorizedEvent('customer', 'otp'),
		new TransferFailedEvent('beneficiary-account-closed'),
		new TransferReversedEvent('auto-reversal'),
	];

	const cardEvents: IEvent[] = [
		new CardIssuedEvent(cardId.value, primaryAccountId.value, '4421', 'visa'),
		new CardActivatedEvent('app'),
		new CardAuthRequestedEvent('Nimbus Grocery', 54.25, 'USD', '5411'),
		new CardAuthApprovedEvent('AP-55122'),
		new CardCaptureEvent(54.25, 'CAP-9190'),
		new CardAuthRequestedEvent('Skyline Rideshare', 18.75, 'USD', '4121'),
		new CardAuthApprovedEvent('AP-55189'),
		new CardCaptureEvent(18.75, 'CAP-9201'),
		new CardAuthRequestedEvent('Metro Electronics', 480.99, 'USD', '5732'),
		new CardAuthDeclinedEvent('insufficient-funds'),
		new CardAuthRequestedEvent('Nimbus Grocery', 12.4, 'USD', '5411'),
		new CardAuthApprovedEvent('AP-55214'),
		new CardCaptureEvent(12.4, 'CAP-9250'),
		new CardRefundInitiatedEvent(12.4, 'duplicate-charge'),
		new CardRefundSettledEvent(12.4, addMinutes(baseDate, 780).toISOString()),
	];

	const disputeEvents: IEvent[] = [
		new DisputeOpenedEvent(disputeId.value, 'CAP-9190', 'services-not-rendered'),
		new DisputeEvidenceSubmittedEvent('merchant', 3),
		new ChargebackIssuedEvent(54.25, '4855'),
		new AccountFeeAppliedEvent('chargeback', 15),
		new DisputeClosedEvent('partial'),
	];

	const complianceEvents: IEvent[] = [
		new ComplianceReviewOpenedEvent(complianceReviewId.value, 'cash-velocity'),
		new ComplianceReviewResolvedEvent(complianceReviewId.value, 'approved'),
	];

	const streams: BankingScenarioStream[] = [
		{
			name: 'customer-onboarding',
			aggregateId: customerId.value,
			streamId: EventStream.for(CustomerAggregate, customerId).streamId,
			events: createEventEnvelopes({
				eventMap,
				aggregateId: customerId.value,
				events: customerEvents,
				startDate: baseDate,
			}),
		},
		{
			name: 'checking-account',
			aggregateId: primaryAccountId.value,
			streamId: EventStream.for(AccountAggregate, primaryAccountId).streamId,
			events: createEventEnvelopes({
				eventMap,
				aggregateId: primaryAccountId.value,
				events: primaryAccountEvents,
				startDate: addMinutes(baseDate, 30),
			}),
		},
		{
			name: 'savings-account',
			aggregateId: savingsAccountId.value,
			streamId: EventStream.for(AccountAggregate, savingsAccountId).streamId,
			events: createEventEnvelopes({
				eventMap,
				aggregateId: savingsAccountId.value,
				events: savingsAccountEvents,
				startDate: addMinutes(baseDate, 45),
			}),
		},
		{
			name: 'card-ledger',
			aggregateId: cardId.value,
			streamId: EventStream.for(CardAggregate, cardId).streamId,
			events: createEventEnvelopes({
				eventMap,
				aggregateId: cardId.value,
				events: cardEvents,
				startDate: addMinutes(baseDate, 120),
			}),
		},
		{
			name: 'transfers',
			aggregateId: transferId.value,
			streamId: EventStream.for(TransferAggregate, transferId).streamId,
			events: createEventEnvelopes({
				eventMap,
				aggregateId: transferId.value,
				events: transferEvents,
				startDate: addMinutes(baseDate, 90),
				correlationId: transferCorrelationId,
			}),
		},
		{
			name: 'disputes',
			aggregateId: disputeId.value,
			streamId: EventStream.for(DisputeAggregate, disputeId).streamId,
			events: createEventEnvelopes({
				eventMap,
				aggregateId: disputeId.value,
				events: disputeEvents,
				startDate: addMinutes(baseDate, 720),
				correlationId: disputeCorrelationId,
			}),
		},
		{
			name: 'compliance-review',
			aggregateId: complianceReviewId.value,
			streamId: EventStream.for(ComplianceReviewAggregate, complianceReviewId).streamId,
			events: createEventEnvelopes({
				eventMap,
				aggregateId: complianceReviewId.value,
				events: complianceEvents,
				startDate: addMinutes(baseDate, 500),
			}),
		},
	];

	const allEvents = streams.flatMap((stream) => stream.events);

	return {
		name: 'banking-production-suite',
		streams,
		allEvents,
		eventMap,
	};
};
