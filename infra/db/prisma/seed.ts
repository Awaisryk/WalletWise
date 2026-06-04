import { PrismaClient } from '@prisma/client';
import { dedupeHash } from '@walletwise/contracts';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const prisma = new PrismaClient();

interface CsvRow {
  date: string;
  amount: string;
  merchant: string;
  category: string;
  account: string;
}

async function parseCsv(filePath: string): Promise<CsvRow[]> {
  const rows: CsvRow[] = [];
  const rl = createInterface({ input: createReadStream(filePath) });
  let isHeader = true;
  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    const [date = '', amount = '', merchant = '', category = '', account = ''] = line.split(',');
    rows.push({ date: date.trim(), amount: amount.trim(), merchant: merchant.trim(), category: category.trim(), account: account.trim() });
  }
  return rows;
}

async function main() {
  // Upsert demo user
  const user = await prisma.user.upsert({
    where: { authId: 'seed-demo' },
    update: {},
    create: { authId: 'seed-demo', email: 'demo@walletwise.dev' },
  });
  console.log(`Demo user: ${user.id}`);

  const csvPath = resolve(__dirname, '../sample/transactions.csv');
  const rows = await parseCsv(csvPath);

  let imported = 0;
  let skipped = 0;

  for (const row of rows) {
    // Skip rows with missing required fields: date, amount, merchant
    if (!row.date || !row.amount || !row.merchant) {
      console.log(`  skip (missing required field): date="${row.date}" amount="${row.amount}" merchant="${row.merchant}"`);
      skipped++;
      continue;
    }

    // Validate date
    const postedAt = new Date(row.date);
    if (isNaN(postedAt.getTime())) {
      console.log(`  skip (invalid date): "${row.date}"`);
      skipped++;
      continue;
    }

    // Validate amount is a number
    const amount = parseFloat(row.amount);
    if (isNaN(amount)) {
      console.log(`  skip (invalid amount): "${row.amount}"`);
      skipped++;
      continue;
    }

    const hash = dedupeHash({
      userId: user.id,
      postedAt: row.date,
      amount,
      merchantRaw: row.merchant,
    });

    try {
      await prisma.transaction.upsert({
        where: { userId_dedupeHash: { userId: user.id, dedupeHash: hash } },
        update: {},
        create: {
          userId: user.id,
          postedAt,
          amount,
          currency: 'USD',
          merchantRaw: row.merchant,
          category: row.category || null,
          source: 'csv',
          dedupeHash: hash,
        },
      });
      imported++;
    } catch (err) {
      console.log(`  skip (db error): ${String(err)}`);
      skipped++;
    }
  }

  console.log(`\nSeed complete: imported=${imported} skipped=${skipped} total=${rows.length}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
