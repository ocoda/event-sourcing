import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DomainExceptionsFilter } from './application/exceptions';

async function bootstrap() {
	const app = await NestFactory.create(AppModule);

	const { httpAdapter } = app.get(HttpAdapterHost);
	app.useGlobalFilters(new DomainExceptionsFilter(httpAdapter));

	await app.listen(3000);
}
bootstrap();
