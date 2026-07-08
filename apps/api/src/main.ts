import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Enable lifecycle hooks (SIGTERM/SIGINT) so DrizzleModule.onModuleDestroy
  // drains the pg pool on shutdown instead of severing in-flight connections.
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 4000);
}
void bootstrap();
