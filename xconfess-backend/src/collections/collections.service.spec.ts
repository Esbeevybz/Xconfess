import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CollectionsService } from './collections.service';
import { UserCollection } from './entities/user-collection.entity';
import { UserCollectionItem } from './entities/user-collection-item.entity';
import { BadRequestException } from '@nestjs/common';

describe('CollectionsService - Bulk Deletion and Associations', () => {
  let service: CollectionsService;
  let collectionRepo: any;
  let itemRepo: any;
  let dataSource: any;

  beforeEach(async () => {
    collectionRepo = {
      create: jest.fn().mockImplementation((dto) => ({ ...dto, id: 'col-1' })),
      save: jest.fn().mockImplementation((c) => Promise.resolve(c)),
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      remove: jest.fn(),
    };

    itemRepo = {
      delete: jest.fn().mockResolvedValue(undefined),
    };

    dataSource = {
      transaction: jest.fn().mockImplementation((cb) =>
        cb({
          find: jest.fn().mockResolvedValue([{ id: 'c-1', userId: 10 }]),
          delete: jest.fn().mockResolvedValue(undefined),
          remove: jest.fn().mockResolvedValue(undefined),
        }),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CollectionsService,
        { provide: getRepositoryToken(UserCollection), useValue: collectionRepo },
        { provide: getRepositoryToken(UserCollectionItem), useValue: itemRepo },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get<CollectionsService>(CollectionsService);
  });

  it('rejects bulk deletion batches exceeding the 25 limit', async () => {
    const tooMany = Array.from({ length: 30 }, (_, i) => `uuid-${i}`);
    await expect(
      service.bulkDeleteCollections(10, { collectionIds: tooMany }),
    ).rejects.toThrow(BadRequestException);
  });

  it('safely handles repeated calls idempotently when some collections are already deleted', async () => {
    const result = await service.bulkDeleteCollections(10, {
      collectionIds: ['c-1', 'c-already-deleted'],
    });

    expect(result.requestedCount).toBe(2);
    expect(result.deletedCount).toBe(1);
    expect(result.alreadyDeletedCount).toBe(1);
    expect(result.deletedIds).toEqual(['c-1']);
    expect(result.alreadyDeletedIds).toEqual(['c-already-deleted']);
  });
});
