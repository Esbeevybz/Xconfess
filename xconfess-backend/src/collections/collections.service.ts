import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import { UserCollection } from './entities/user-collection.entity';
import { UserCollectionItem } from './entities/user-collection-item.entity';
import {
  CreateCollectionDto,
  UpdateCollectionDto,
  ReorderCollectionsDto,
} from './dto/collection.dto';
import { BulkDeleteCollectionsDto } from './dto/bulk-delete-collections.dto';

export interface BulkDeleteResult {
  requestedCount: number;
  deletedCount: number;
  alreadyDeletedCount: number;
  deletedIds: string[];
  alreadyDeletedIds: string[];
}

@Injectable()
export class CollectionsService {
  private readonly logger = new Logger(CollectionsService.name);
  private readonly MAX_BULK_DELETE = 25;

  constructor(
    @InjectRepository(UserCollection)
    private readonly collectionRepo: Repository<UserCollection>,
    @InjectRepository(UserCollectionItem)
    private readonly itemRepo: Repository<UserCollectionItem>,
    private readonly dataSource: DataSource,
  ) {}

  async createCollection(
    userId: number,
    dto: CreateCollectionDto,
  ): Promise<UserCollection> {
    const highestOrder = await this.collectionRepo
      .createQueryBuilder('c')
      .where('c.user_id = :userId', { userId })
      .select('MAX(c.display_order)', 'maxOrder')
      .getRawOne();

    const nextOrder = (highestOrder?.maxOrder ?? -1) + 1;

    const collection = this.collectionRepo.create({
      userId,
      name: dto.name.trim(),
      description: dto.description?.trim(),
      displayOrder: nextOrder,
      isPrivate: dto.isPrivate ?? true,
      version: 1,
    });

    return this.collectionRepo.save(collection);
  }

  async getCollections(userId: number): Promise<UserCollection[]> {
    return this.collectionRepo.find({
      where: { userId },
      order: { displayOrder: 'ASC', createdAt: 'ASC' },
    });
  }

  async getCollectionById(userId: number, id: string): Promise<UserCollection> {
    const collection = await this.collectionRepo.findOne({ where: { id } });
    if (!collection) {
      throw new NotFoundException({
        code: 'COLLECTION_NOT_FOUND',
        message: `Collection ${id} not found`,
      });
    }

    if (collection.userId !== userId) {
      throw new ForbiddenException({
        code: 'COLLECTION_ACCESS_DENIED',
        message: 'You are not authorized to access this private collection',
      });
    }

    return collection;
  }

  async updateCollection(
    userId: number,
    id: string,
    dto: UpdateCollectionDto,
  ): Promise<UserCollection> {
    const collection = await this.getCollectionById(userId, id);

    if (
      dto.expectedVersion !== undefined &&
      dto.expectedVersion !== collection.version
    ) {
      throw new ConflictException({
        code: 'COLLECTION_CONCURRENCY_CONFLICT',
        message:
          'Collection has been updated by another operation. Please refresh and retry.',
        currentVersion: collection.version,
        expectedVersion: dto.expectedVersion,
      });
    }

    if (dto.name !== undefined) collection.name = dto.name.trim();
    if (dto.description !== undefined)
      collection.description = dto.description?.trim();
    if (dto.isPrivate !== undefined) collection.isPrivate = dto.isPrivate;

    return this.collectionRepo.save(collection);
  }

  async reorderCollections(
    userId: number,
    dto: ReorderCollectionsDto,
  ): Promise<UserCollection[]> {
    const userCollections = await this.getCollections(userId);
    const existingMap = new Map(userCollections.map((c) => [c.id, c]));

    for (const id of dto.collectionIds) {
      if (!existingMap.has(id)) {
        throw new NotFoundException({
          code: 'COLLECTION_NOT_FOUND',
          message: `Collection ${id} not found or not owned by user`,
        });
      }
    }

    await this.dataSource.transaction(async (manager) => {
      for (let i = 0; i < dto.collectionIds.length; i++) {
        const id = dto.collectionIds[i];
        await manager.update(UserCollection, { id, userId }, { displayOrder: i });
      }
    });

    return this.getCollections(userId);
  }

  async deleteCollection(userId: number, id: string): Promise<void> {
    const collection = await this.getCollectionById(userId, id);
    await this.collectionRepo.remove(collection);
  }

  /**
   * Owner-safe bulk deletion for private collections (Issue #399).
   * Executes in bounded transactions, preserves underlying confession records,
   * and handles repeated requests idempotently.
   */
  async bulkDeleteCollections(
    userId: number,
    dto: BulkDeleteCollectionsDto,
  ): Promise<BulkDeleteResult> {
    if (dto.collectionIds.length > this.MAX_BULK_DELETE) {
      throw new BadRequestException({
        code: 'MAX_BATCH_SIZE_EXCEEDED',
        message: `Bulk delete batch cannot exceed ${this.MAX_BULK_DELETE} collections`,
      });
    }

    const uniqueIds = Array.from(new Set(dto.collectionIds));
    const deletedIds: string[] = [];
    const alreadyDeletedIds: string[] = [];

    await this.dataSource.transaction(async (manager) => {
      const ownedCollections = await manager.find(UserCollection, {
        where: {
          id: In(uniqueIds),
          userId,
        },
      });

      const ownedMap = new Map(ownedCollections.map((c) => [c.id, c]));

      for (const id of uniqueIds) {
        const col = ownedMap.get(id);
        if (col) {
          // Delete collection associations (preserves underlying confessions)
          await manager.delete(UserCollectionItem, { collectionId: id });
          await manager.remove(UserCollection, col);
          deletedIds.push(id);
        } else {
          // Idempotent safe handling for repeated/already deleted calls
          alreadyDeletedIds.push(id);
        }
      }
    });

    this.logger.log(
      `[AUDIT] COLLECTIONS_BULK_DELETED userId=${userId} deleted=${deletedIds.length} alreadyDeleted=${alreadyDeletedIds.length}`,
    );

    return {
      requestedCount: uniqueIds.length,
      deletedCount: deletedIds.length,
      alreadyDeletedCount: alreadyDeletedIds.length,
      deletedIds,
      alreadyDeletedIds,
    };
  }
}
