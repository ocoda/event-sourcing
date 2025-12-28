import { NestFactory } from '@nestjs/core';
export async function bootstrap(module: any) {
	const app = await NestFactory.create(module, { logger: false });

	await app.listen(3000);
	console.log('Server is listening');
}
