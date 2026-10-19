import { Module } from '@nestjs/common';
import { LocalesModule } from '../locales/locales.module';
import { TagsModule } from '../tags/tags.module';
import {
  KyselyTranslationQueryRepository,
  TranslationQueryRepository,
} from './translation-query.repository';
import { KyselyTranslationRepository, TranslationRepository } from './translation.repository';
import { TranslationsController } from './translations.controller';
import { TranslationsService } from './translations.service';
import { LocaleValueMapConstraint } from './validators/locale-value-map.validator';

@Module({
  imports: [LocalesModule, TagsModule],
  controllers: [TranslationsController],
  providers: [
    TranslationsService,
    LocaleValueMapConstraint,
    { provide: TranslationRepository, useClass: KyselyTranslationRepository },
    { provide: TranslationQueryRepository, useClass: KyselyTranslationQueryRepository },
  ],
})
export class TranslationsModule {}
