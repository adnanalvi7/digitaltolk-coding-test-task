import { Injectable } from '@nestjs/common';
import { mapCooperatively } from '../../common/async/yield-to-event-loop';
import { type ExportEntry, ExportFormat, ExportFormatter } from './export-formatter';

/**
 * `{ "checkout.button.pay": "Pay now", ... }` — written straight to a JSON
 * string, without materialising an intermediate object per entry, and in
 * chunks so other requests are served in between.
 */
@Injectable()
export class FlatExportFormatter extends ExportFormatter {
  readonly format = ExportFormat.Flat;
  readonly contentType = 'application/json; charset=utf-8';

  async render(entries: readonly ExportEntry[]): Promise<string> {
    const members = await mapCooperatively(
      entries,
      ({ key, value }) => `${JSON.stringify(key)}:${JSON.stringify(value)}`,
    );
    return `{${members.join(',')}}`;
  }
}
