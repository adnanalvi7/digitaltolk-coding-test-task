import { Module } from '@nestjs/common';
import { KyselyTagRepository, TagRepository } from './tag.repository';
import { TagsController } from './tags.controller';

@Module({
  controllers: [TagsController],
  providers: [{ provide: TagRepository, useClass: KyselyTagRepository }],
  exports: [TagRepository],
})
export class TagsModule {}
