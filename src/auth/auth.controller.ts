import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { type DataEnvelope, ApiEnvelopedResponse, envelope } from '../common/http/envelope';
import { ApiProblemResponses, BODY_ERRORS } from '../common/http/problem-responses';
import { CountCredentialFailuresInterceptor } from '../throttling/count-credential-failures.interceptor';
import { RateLimitPolicy } from '../throttling/rate-limit-policy';
import { CurrentPrincipal, Public } from './auth.decorators';
import { CreateTokenDto } from './dto/create-token.dto';
import { IssuedTokenResponse } from './dto/issued-token.response';
import type { AuthPrincipal } from './principal';
import { TokenService } from './token.service';

@ApiTags('auth')
@Controller('auth/tokens')
export class AuthController {
  constructor(private readonly tokens: TokenService) {}

  @Post()
  @Public()
  @RateLimitPolicy('auth')
  @UseInterceptors(CountCredentialFailuresInterceptor)
  @ApiOperation({
    summary: 'Exchange credentials for an API token',
    description: 'Hard-throttled per IP + email. The plaintext token is returned only once.',
  })
  @ApiEnvelopedResponse(IssuedTokenResponse, { status: HttpStatus.CREATED, description: 'Issued' })
  @ApiProblemResponses(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.TOO_MANY_REQUESTS,
    ...BODY_ERRORS,
  )
  async create(@Body() dto: CreateTokenDto): Promise<DataEnvelope<IssuedTokenResponse>> {
    const issued = await this.tokens.issue({
      email: dto.email,
      password: dto.password,
      name: dto.name,
      scopes: dto.scopes,
      ttlSeconds: dto.ttlSeconds,
    });
    return envelope(new IssuedTokenResponse(issued));
  }

  @Delete('current')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke the token used for this request' })
  @ApiNoContentResponse({ description: 'Revoked' })
  @ApiProblemResponses(HttpStatus.UNAUTHORIZED, HttpStatus.TOO_MANY_REQUESTS)
  async revokeCurrent(@CurrentPrincipal() principal: AuthPrincipal): Promise<void> {
    await this.tokens.revoke(principal);
  }
}
