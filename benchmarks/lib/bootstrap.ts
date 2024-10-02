import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { DomainExceptionsFilter } from '@ocoda/event-sourcing-example';

export async function bootstrap(module: any) {
	const app = await NestFactory.create(module, { logger: false });

	const { httpAdapter } = app.get(HttpAdapterHost);
	app.useGlobalFilters(new DomainExceptionsFilter(httpAdapter));

	await app.listen(3000);
	console.log('Server is listening');
}
