import { Inject, Injectable } from '@nestjs/common';
import { EXPORT_FORMATTERS, type ExportFormat, ExportFormatter } from './export-formatter';

/** Looks up the formatter strategy for a format. Closed for modification. */
@Injectable()
export class ExportFormatterRegistry {
  private readonly byFormat: ReadonlyMap<ExportFormat, ExportFormatter>;

  constructor(@Inject(EXPORT_FORMATTERS) formatters: readonly ExportFormatter[]) {
    this.byFormat = new Map(formatters.map((formatter) => [formatter.format, formatter]));
  }

  get(format: ExportFormat): ExportFormatter {
    const formatter = this.byFormat.get(format);
    if (!formatter) throw new Error(`No export formatter registered for "${format}"`);
    return formatter;
  }
}
