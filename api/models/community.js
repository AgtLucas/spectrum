// @flow
const { db } = require('./db');
import { parseRange } from './utils';
import { uploadImage } from '../utils/s3';
import getRandomDefaultPhoto from '../utils/get-random-default-photo';
import {
  sendNewCommunityWelcomeEmailQueue,
  _adminSendCommunityCreatedEmailQueue,
} from 'shared/bull/queues';
import { removeMemberInChannel } from './usersChannels';
import type { DBCommunity } from 'shared/types';
import type { Timeframe } from './utils';

export const getCommunityById = (id: string): Promise<DBCommunity> => {
  return db
    .table('communities')
    .get(id)
    .run()
    .then(result => {
      if (result && result.deletedAt) return null;
      return result;
    });
};

export const getCommunities = (
  communityIds: Array<string>
): Promise<Array<DBCommunity>> => {
  return db
    .table('communities')
    .getAll(...communityIds)
    .filter(community => db.not(community.hasFields('deletedAt')))
    .run();
};

export const getCommunitiesBySlug = (
  slugs: Array<string>
): Promise<Array<DBCommunity>> => {
  return db
    .table('communities')
    .getAll(...slugs, { index: 'slug' })
    .filter(community => db.not(community.hasFields('deletedAt')))
    .run();
};

export const getCommunitiesByUser = (
  userId: string
): Promise<Array<DBCommunity>> => {
  return (
    db
      .table('usersCommunities')
      // get all the user's communities
      .getAll(userId, { index: 'userId' })
      // only return communities the user is a member of
      .filter({ isMember: true })
      // get the community objects for each community
      .eqJoin('communityId', db.table('communities'))
      // get rid of unnecessary info from the usersCommunities object on the left
      .without({ left: ['id', 'communityId', 'userId', 'createdAt'] })
      // zip the tables
      .zip()
      // ensure we don't return any deleted communities
      .filter(community => db.not(community.hasFields('deletedAt')))
      .run()
  );
};

export const getCommunitiesChannelCounts = (communityIds: Array<string>) => {
  return db
    .table('channels')
    .getAll(...communityIds, { index: 'communityId' })
    .filter(channel => db.not(channel.hasFields('deletedAt')))
    .group('communityId')
    .count()
    .run();
};

export const getCommunitiesMemberCounts = (communityIds: Array<string>) => {
  return db
    .table('usersCommunities')
    .getAll(...communityIds, { index: 'communityId' })
    .filter({ isBlocked: false, isMember: true })
    .group('communityId')
    .count()
    .run();
};

export const getCommunityMetaData = (
  communityId: string
): Promise<Array<number>> => {
  const getChannelCount = db
    .table('channels')
    .getAll(communityId, { index: 'communityId' })
    .filter(channel => db.not(channel.hasFields('deletedAt')))
    .count()
    .run();

  const getMemberCount = db
    .table('usersCommunities')
    .getAll(communityId, { index: 'communityId' })
    .filter({ isBlocked: false, isMember: true })
    .count()
    .run();

  return Promise.all([getChannelCount, getMemberCount]);
};

export const getMemberCount = (communityId: string): Promise<number> => {
  return db
    .table('usersCommunities')
    .getAll(communityId, { index: 'communityId' })
    .filter({ isBlocked: false, isMember: true })
    .count()
    .run();
};

export type CreateCommunityInput = {
  input: {
    name: string,
    slug: string,
    description: string,
    website: string,
    file: Object,
    coverFile: Object,
  },
};

export type EditCommunityInput = {
  input: {
    name: string,
    slug: string,
    description: string,
    website: string,
    file: Object,
    coverFile: Object,
    communityId: string,
  },
};

// TODO(@mxstbr): Use DBUser type
type CommunityCreator = Object;

export const createCommunity = (
  {
    input: { name, slug, description, website, file, coverFile },
  }: CreateCommunityInput,
  user: CommunityCreator
): Promise<DBCommunity> => {
  return db
    .table('communities')
    .insert(
      {
        createdAt: new Date(),
        name,
        description,
        website,
        profilePhoto: null,
        coverPhoto: null,
        slug,
        modifiedAt: null,
        creatorId: user.id,
        administratorEmail: user.email,
        stripeCustomerId: null,
      },
      { returnChanges: true }
    )
    .run()
    .then(result => result.changes[0].new_val)
    .then(community => {
      // send a welcome email to the community creator
      sendNewCommunityWelcomeEmailQueue.add({ user, community });
      // email brian with info about the community and owner
      _adminSendCommunityCreatedEmailQueue.add({ user, community });

      // if no file was uploaded, update the community with new string values
      if (!file && !coverFile) {
        const { coverPhoto, profilePhoto } = getRandomDefaultPhoto();
        return db
          .table('communities')
          .get(community.id)
          .update(
            { ...community, profilePhoto, coverPhoto },
            { returnChanges: 'always' }
          )
          .run()
          .then(result => {
            // if an update happened
            if (result.replaced === 1) {
              return result.changes[0].new_val;
            }

            // an update was triggered from the client, but no data was changed
            if (result.unchanged === 1) {
              return result.changes[0].old_val;
            }
            return null;
          });
      }

      if (file || coverFile) {
        if (file && !coverFile) {
          const { coverPhoto } = getRandomDefaultPhoto();
          return uploadImage(file, 'communities', community.id).then(
            profilePhoto => {
              return (
                db
                  .table('communities')
                  .get(community.id)
                  .update(
                    {
                      ...community,
                      profilePhoto,
                      coverPhoto,
                    },
                    { returnChanges: 'always' }
                  )
                  .run()
                  // return the resulting community with the profilePhoto set
                  .then(result => {
                    // if an update happened
                    if (result.replaced === 1) {
                      return result.changes[0].new_val;
                    }

                    // an update was triggered from the client, but no data was changed
                    if (result.unchanged === 1) {
                      return result.changes[0].old_val;
                    }
                  })
              );
            }
          );
        } else if (!file && coverFile) {
          const { profilePhoto } = getRandomDefaultPhoto();
          return uploadImage(coverFile, 'communities', community.id).then(
            coverPhoto => {
              // update the community with the profilePhoto
              return (
                db
                  .table('communities')
                  .get(community.id)
                  .update(
                    {
                      ...community,
                      coverPhoto,
                      profilePhoto,
                    },
                    { returnChanges: 'always' }
                  )
                  .run()
                  // return the resulting community with the profilePhoto set
                  .then(result => {
                    // if an update happened
                    if (result.replaced === 1) {
                      return result.changes[0].new_val;
                    }

                    // an update was triggered from the client, but no data was changed
                    if (result.unchanged === 1) {
                      return result.changes[0].old_val;
                    }

                    return null;
                  })
              );
            }
          );
        } else if (file && coverFile) {
          const uploadFile = file => {
            return uploadImage(file, 'communities', community.id);
          };

          const uploadCoverFile = coverFile => {
            return uploadImage(coverFile, 'communities', community.id);
          };

          return Promise.all([
            uploadFile(file),
            uploadCoverFile(coverFile),
          ]).then(([profilePhoto, coverPhoto]) => {
            return (
              db
                .table('communities')
                .get(community.id)
                .update(
                  {
                    ...community,
                    coverPhoto,
                    profilePhoto,
                  },
                  { returnChanges: 'always' }
                )
                .run()
                // return the resulting community with the profilePhoto set
                .then(result => {
                  // if an update happened
                  if (result.replaced === 1) {
                    return result.changes[0].new_val;
                  }

                  // an update was triggered from the client, but no data was changed
                  if (result.unchanged === 1) {
                    return result.changes[0].old_val;
                  }

                  return null;
                })
            );
          });
        }
      }
    });
};

export const editCommunity = ({
  input: { name, slug, description, website, file, coverFile, communityId },
}: EditCommunityInput): Promise<DBCommunity> => {
  return db
    .table('communities')
    .get(communityId)
    .run()
    .then(result => {
      return Object.assign({}, result, {
        name,
        slug,
        description,
        website,
        modifiedAt: new Date(),
      });
    })
    .then(community => {
      // if no file was uploaded, update the community with new string values
      if (!file && !coverFile) {
        return db
          .table('communities')
          .get(communityId)
          .update({ ...community }, { returnChanges: 'always' })
          .run()
          .then(result => {
            // if an update happened
            if (result.replaced === 1) {
              return result.changes[0].new_val;
            }

            // an update was triggered from the client, but no data was changed
            if (result.unchanged === 1) {
              return result.changes[0].old_val;
            }
          });
      }

      if (file || coverFile) {
        if (file && !coverFile) {
          return uploadImage(file, 'communities', community.id).then(
            profilePhoto => {
              // update the community with the profilePhoto
              return (
                db
                  .table('communities')
                  .get(community.id)
                  .update(
                    {
                      ...community,
                      profilePhoto,
                    },
                    { returnChanges: 'always' }
                  )
                  .run()
                  // return the resulting community with the profilePhoto set
                  .then(result => {
                    // if an update happened
                    if (result.replaced === 1) {
                      return result.changes[0].new_val;
                    }

                    // an update was triggered from the client, but no data was changed
                    if (result.unchanged === 1) {
                      return result.changes[0].old_val;
                    }
                  })
              );
            }
          );
        } else if (!file && coverFile) {
          return uploadImage(coverFile, 'communities', community.id).then(
            coverPhoto => {
              // update the community with the profilePhoto
              return (
                db
                  .table('communities')
                  .get(community.id)
                  .update(
                    {
                      ...community,
                      coverPhoto,
                    },
                    { returnChanges: 'always' }
                  )
                  .run()
                  // return the resulting community with the profilePhoto set
                  .then(result => {
                    // if an update happened
                    if (result.replaced === 1) {
                      return result.changes[0].new_val;
                    }

                    // an update was triggered from the client, but no data was changed
                    if (result.unchanged === 1) {
                      return result.changes[0].old_val;
                    }
                  })
              );
            }
          );
        } else if (file && coverFile) {
          const uploadFile = file => {
            return uploadImage(file, 'communities', community.id);
          };

          const uploadCoverFile = coverFile => {
            return uploadImage(coverFile, 'communities', community.id);
          };

          return Promise.all([
            uploadFile(file),
            uploadCoverFile(coverFile),
          ]).then(([profilePhoto, coverPhoto]) => {
            return (
              db
                .table('communities')
                .get(community.id)
                .update(
                  {
                    ...community,
                    coverPhoto,
                    profilePhoto,
                  },
                  { returnChanges: 'always' }
                )
                .run()
                // return the resulting community with the profilePhoto set
                .then(result => {
                  // if an update happened
                  if (result.replaced === 1) {
                    return result.changes[0].new_val;
                  }

                  // an update was triggered from the client, but no data was changed
                  if (result.unchanged === 1) {
                    return result.changes[0].old_val;
                  }

                  return null;
                })
            );
          });
        }
      }
    });
};

/*
  We delete data non-destructively, meaning the record does not get cleared
  from the db. Instead, we set a 'deleted' field on the object with a value
  of the current time on the db.

  We set the value as a timestamp so that in the future we have option value
  to perform actions like:
  - permanantely delete records that were deleted > X days ago
  - run logs for deletions over time
  - etc
*/
export const deleteCommunity = (communityId: string): Promise<DBCommunity> => {
  return db
    .table('communities')
    .get(communityId)
    .update(
      {
        deletedAt: new Date(),
        slug: db.uuid(),
      },
      {
        returnChanges: 'always',
        nonAtomic: true,
      }
    )
    .run();
};

export const setPinnedThreadInCommunity = (
  communityId: string,
  value: string
): Promise<DBCommunity> => {
  return db
    .table('communities')
    .get(communityId)
    .update(
      {
        pinnedThreadId: value,
      },
      { returnChanges: 'always' }
    )
    .run()
    .then(result => result.changes[0].new_val);
};

export const unsubscribeFromAllChannelsInCommunity = (
  communityId: string,
  userId: string
): Promise<Array<Object>> => {
  return db
    .table('channels')
    .getAll(communityId, { index: 'communityId' })
    .run()
    .then(channels => {
      return channels.map(channel => removeMemberInChannel(channel.id, userId));
    });
};

export const userIsMemberOfCommunity = (
  communityId: string,
  userId: string
): Promise<Boolean> => {
  return db
    .table('communities')
    .get(communityId)
    .run()
    .then(community => {
      return community.members.indexOf(userId) > -1;
    });
};

export const userIsMemberOfAnyChannelInCommunity = (
  communityId: string,
  userId: string
): Promise<Boolean> => {
  return db('spectrum')
    .table('channels')
    .getAll(communityId, { index: 'communityId' })
    .eqJoin('id', db.table('usersChannels'), { index: 'channelId' })
    .zip()
    .filter({ userId })
    .pluck('isMember')
    .run()
    .then(channels => {
      // if any of the channels return true for isMember, we return true
      return channels.some(channel => channel.isMember);
    });
};

export const getRecentCommunities = (): Array<DBCommunity> => {
  return db
    .table('communities')
    .orderBy({ index: db.desc('createdAt') })
    .filter(community => db.not(community.hasFields('deletedAt')))
    .limit(100)
    .run();
};

export const getCommunitiesBySearchString = (
  string: string,
  amount: number
): Promise<Array<DBCommunity>> => {
  return db
    .table('communities')
    .filter(community => community.coerceTo('string').match(`(?i)${string}`))
    .filter(community => db.not(community.hasFields('deletedAt')))
    .limit(amount)
    .run();
};

// TODO(@mxstbr): Replace Array<Object> with Array<DBThread>
export const searchThreadsInCommunity = (
  channels: Array<string>,
  searchString: string
): Promise<Array<Object>> => {
  return db
    .table('threads')
    .getAll(...channels, { index: 'channelId' })
    .filter(thread => thread.coerceTo('string').match(`(?i)${searchString}`))
    .filter(thread => db.not(thread.hasFields('deletedAt')))
    .orderBy(db.desc('lastActive'))
    .run();
};

export const getThreadCount = (communityId: string) => {
  return db
    .table('threads')
    .getAll(communityId, { index: 'communityId' })
    .filter(thread => db.not(thread.hasFields('deletedAt')))
    .count()
    .run();
};

export const getCommunityGrowth = async (
  table: string,
  range: Timeframe,
  field: string,
  communityId: string,
  filter?: mixed
) => {
  const { current, previous } = parseRange(range);
  const currentPeriodCount = await db
    .table(table)
    .getAll(communityId, { index: 'communityId' })
    .filter(db.row(field).during(db.now().sub(current), db.now()))
    .filter(filter ? filter : '')
    .count()
    .run();

  const prevPeriodCount = await db
    .table(table)
    .getAll(communityId, { index: 'communityId' })
    .filter(db.row(field).during(db.now().sub(previous), db.now().sub(current)))
    .filter(filter ? filter : '')
    .count()
    .run();

  const rate = (await (currentPeriodCount - prevPeriodCount)) / prevPeriodCount;
  return {
    currentPeriodCount,
    prevPeriodCount,
    growth: Math.round(rate * 100),
  };
};

export const setCommunityPendingAdministratorEmail = (
  communityId: string,
  pendingAdministratorEmail: string
): Promise<Object> => {
  return db
    .table('communities')
    .get(communityId)
    .update({
      pendingAdministratorEmail,
    })
    .run()
    .then(() => getCommunityById(communityId));
};

export const updateCommunityAdministratorEmail = (
  communityId: string,
  administratorEmail: string
): Promise<Object> => {
  return db
    .table('communities')
    .get(communityId)
    .update({
      administratorEmail,
      pendingAdministratorEmail: db.literal(),
    })
    .run()
    .then(() => getCommunityById(communityId));
};

export const resetCommunityAdministratorEmail = (communityId: string) => {
  return db
    .table('communities')
    .get(communityId)
    .update({
      administratorEmail: null,
      pendingAdministratorEmail: db.literal(),
    })
    .run();
};

export const setStripeCustomerId = (
  communityId: string,
  stripeCustomerId: string
): Promise<DBCommunity> => {
  return db
    .table('communities')
    .get(communityId)
    .update(
      {
        stripeCustomerId,
      },
      {
        returnChanges: 'always',
      }
    )
    .run()
    .then(result => result.changes[0].new_val || result.changes[0].old_val);
};

export const disablePaidFeatureFlags = (communityId: string) => {
  return db
    .table('communities')
    .get(communityId)
    .update({
      analyticsEnabled: false,
      prioritySupportEnabled: false,
    })
    .run();
};

export const updateCommunityPaidFeature = (
  communityId: string,
  feature: string,
  value: boolean
) => {
  const obj = { [feature]: value };
  return db
    .table('communities')
    .get(communityId)
    .update(obj, { returnChanges: 'always' })
    .run()
    .then(result => {
      if (result && result.changes.length > 0) {
        return result.changes[0].new_val || result.changes[0].old_val;
      }
      return { id: communityId };
    });
};
