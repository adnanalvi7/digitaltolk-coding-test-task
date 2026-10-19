import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import type { OpenAPIObject } from '@nestjs/swagger';
import { buildOpenApiDocument } from '../../src/openapi';
import { type TestApp, createTestApp } from '../support/test-app';

/** Every route Nest registered, as "METHOD /path/{param}". */
function registeredRoutes(t: TestApp): string[] {
  const routes = new Set<string>();
  for (const module of t.app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as (new () => object) | null;
      if (!controller) continue;
      const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = (controller.prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function' || name === 'constructor') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined) continue;
        const sub = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
        const path = ['/api/v1', base, sub]
          .join('/')
          .replace(/\/+/g, '/')
          .replace(/\/$/, '')
          .replace(/:(\w+)/g, '{$1}');
        routes.add(`${RequestMethod[method]} ${path}`);
      }
    }
  }
  return [...routes].sort();
}

function documentedRoutes(document: OpenAPIObject): string[] {
  return Object.entries(document.paths)
    .flatMap(([path, item]) =>
      Object.keys(item)
        .filter((key) => ['get', 'post', 'put', 'patch', 'delete'].includes(key))
        .map((method) => `${method.toUpperCase()} ${path}`),
    )
    .sort();
}

describe('Platform (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  describe('OpenAPI', () => {
    it('documents every registered route', () => {
      const registered = registeredRoutes(t);
      expect(registered).toHaveLength(14);
      expect(documentedRoutes(buildOpenApiDocument(t.app))).toEqual(registered);
    });

    it('declares the bearer scheme and the problem+json error schema', () => {
      const document = buildOpenApiDocument(t.app);
      expect(document.components?.securitySchemes?.bearer).toMatchObject({
        type: 'http',
        scheme: 'bearer',
      });
      expect(document.components?.schemas).toHaveProperty('ProblemDetailsDto');
      const create = document.paths['/api/v1/translations']?.post;
      expect(Object.keys(create?.responses ?? {})).toEqual(
        expect.arrayContaining(['201', '401', '403', '409', '413', '415', '422', '429', '500']),
      );
    });

    it('serves the JSON document and the Swagger UI', async () => {
      const json = await t.http().get('/docs/openapi.json').expect(200);
      expect((json.body as OpenAPIObject).openapi).toMatch(/^3\./);
      await t.http().get('/docs').expect(200).expect('content-type', /html/);
    });
  });

  describe('health', () => {
    it('reports readiness of Postgres and Redis', async () => {
      const response = await t.http().get('/api/v1/health').expect(200);
      expect(response.body).toMatchObject({
        status: 'ok',
        details: { database: { status: 'up' }, redis: { status: 'up' } },
      });
    });

    it('reports liveness', async () => {
      await t.http().get('/api/v1/health/live').expect(200, { status: 'ok' });
    });
  });
});
