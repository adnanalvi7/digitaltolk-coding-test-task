import { Module } from '@nestjs/common';
import { LocaleDirectory } from './locale-directory';
import { KyselyLocaleRepository, LocaleRepository } from './locale.repository';
import { LocalesController } from './locales.controller';
import { LocalesService } from './locales.service';

@Module({
  controllers: [LocalesController],
  providers: [
    LocalesService,
    LocaleDirectory,
    { provide: LocaleRepository, useClass: KyselyLocaleRepository },
  ],
  exports: [LocaleDirectory, LocaleRepository],
})
export class LocalesModule {}
