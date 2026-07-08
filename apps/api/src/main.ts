import { createApp } from './create-app';

async function bootstrap() {
  const app = await createApp();
  // Enable lifecycle hooks (SIGTERM/SIGINT) so DrizzleModule.onModuleDestroy
  // drains the pg pool on shutdown instead of severing in-flight connections.
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 4000);
}
void bootstrap();
