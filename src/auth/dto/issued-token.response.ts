import { ApiProperty } from '@nestjs/swagger';
import type { IssuedToken } from '../token.service';
import { ALL_TOKEN_SCOPES, type TokenScope } from '../token-scope';

export class IssuedTokenResponse {
  @ApiProperty({ description: 'Token id (bigint serialised as a string).', example: '42' })
  readonly id: string;

  @ApiProperty({
    description: 'The bearer token. Shown exactly once; only its SHA-256 is stored.',
    example: 'tms_3q2-7wEXAMPLEonlyEXAMPLEonlyEXAMPLEonly0ab',
  })
  readonly token: string;

  @ApiProperty({ type: String, example: 'Bearer' })
  readonly tokenType: string = 'Bearer';

  @ApiProperty({ example: 'ci-pipeline' })
  readonly name: string;

  @ApiProperty({ enum: ALL_TOKEN_SCOPES, isArray: true })
  readonly scopes: readonly TokenScope[];

  @ApiProperty({ format: 'date-time' })
  readonly expiresAt: string;

  constructor(issued: IssuedToken) {
    this.id = issued.id;
    this.token = issued.token;
    this.name = issued.name;
    this.scopes = issued.scopes;
    this.expiresAt = issued.expiresAt.toISOString();
  }
}
