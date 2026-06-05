import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JOBS, type ImportCsvPayload } from '@walletwise/contracts';
import { SessionGuard } from '../auth/session.guard';
import { User } from '../auth/user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { JobBus } from '../queue/queue.module';

/** Body of `POST /import/csv`. The client posts the raw CSV text as JSON. */
interface ImportCsvBody {
  csv: string;
}

/**
 * CSV import endpoints. The actual parse + insert happens asynchronously in
 * the worker; these endpoints only create the tracking `ImportJob`, enqueue
 * the work, and let the client poll for status.
 *
 * Every query is scoped to the session `userId` (`@User('id')`) — there is no
 * cross-user read path.
 */
@Controller('import')
export class ImportController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobBus: JobBus,
  ) {}

  /**
   * Accept a CSV upload and kick off an async import. We persist an
   * `ImportJob` row in `pending` immediately so the client gets an id to poll,
   * then enqueue the parse+insert work for the worker. The CSV text itself
   * rides in the job payload (not the DB) — the worker is the only consumer.
   */
  @Post('csv')
  @UseGuards(SessionGuard)
  async importCsv(
    @Body() body: ImportCsvBody,
    @User('id') userId: string,
  ): Promise<{ jobId: string }> {
    if (typeof body?.csv !== 'string' || body.csv.trim() === '') {
      throw new BadRequestException('csv must be a non-empty string');
    }

    const job = await this.prisma.importJob.create({
      data: { userId, status: 'pending', rowsTotal: 0 },
    });

    const payload: ImportCsvPayload = { userId, importJobId: job.id, csv: body.csv };
    await this.jobBus.enqueue(JOBS.IMPORT_CSV, payload);

    return { jobId: job.id };
  }

  /**
   * Poll import status. Scoped to the caller via `findFirst({ where: { id,
   * userId } })` so one user can never read another's import job (a bare
   * `findUnique({ where: { id } })` would leak across users). 404 if the id
   * doesn't exist for this user.
   */
  @Get(':id')
  @UseGuards(SessionGuard)
  async getImport(
    @Param('id') id: string,
    @User('id') userId: string,
  ): Promise<{
    status: string;
    rowsTotal: number;
    rowsImported: number;
    rowsSkipped: number;
    report: unknown;
  }> {
    const job = await this.prisma.importJob.findFirst({ where: { id, userId } });
    if (!job) throw new NotFoundException('Import job not found');

    return {
      status: job.status,
      rowsTotal: job.rowsTotal,
      rowsImported: job.rowsImported,
      rowsSkipped: job.rowsSkipped,
      report: job.report,
    };
  }
}
