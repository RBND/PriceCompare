import { initDatabase } from './db.js';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT || 28085);
const db = initDatabase();
const app = createApp(db);

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[PriceIt] Server listening on http://0.0.0.0:${PORT}`);
});

process.on('SIGTERM', () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
});
