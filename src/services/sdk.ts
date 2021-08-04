import { FeedItem, Graph, HexString, Profile } from "../utilities/types";
import * as fakesdk from "./fakesdk";
import { setConfig, core } from "@dsnp/sdk";
import { Publication } from "@dsnp/sdk/core/contracts/publisher";
import { providers } from "ethers";
import { keccak256 } from "web3-utils";
import { addFeedItem, clearFeedItems } from "../redux/slices/feedSlice";
import { upsertProfile } from "../redux/slices/profileSlice";
import { AnyAction, ThunkDispatch } from "@reduxjs/toolkit";
import { Store } from "./Storage";
import {
  ActivityContentNote,
  ActivityContentProfile,
  isActivityContentNote,
  isActivityContentProfile,
} from "@dsnp/sdk/core/activityContent";
import {
  BroadcastAnnouncement,
  AnnouncementType,
  SignedBroadcastAnnouncement,
  SignedReplyAnnouncement,
  ReplyAnnouncement,
} from "@dsnp/sdk/core/announcements";
import { BatchPublicationCallbackArgs } from "@dsnp/sdk/core/contracts/subscription";
import { WalletType } from "./wallets/wallet";
import torusWallet from "./wallets/torus";

interface BatchFileData {
  url: URL;
  hash: HexString;
}

type Dispatch = ThunkDispatch<any, Record<string, any>, AnyAction>;

export const getSocialIdentity = async (
  walletAddress: HexString
): Promise<HexString> => {
  let socialAddress: HexString = await fakesdk.getSocialIdentityfromWalletAddress(
    walletAddress
  );
  if (!socialAddress) {
    socialAddress = await fakesdk.createSocialIdentityfromWalletAddress(
      walletAddress
    );
  }
  return socialAddress;
};

export const getGraph = async (socialAddress: HexString): Promise<Graph> => {
  const graph = await fakesdk.getGraphFromSocialIdentity(socialAddress);
  if (!graph) throw new Error("Invalid Social Identity Address");
  return graph;
};

export const getProfile = async (
  socialAddress: HexString
): Promise<Profile> => {
  const profile = await fakesdk.getProfileFromSocialIdentity(socialAddress);
  if (!profile) throw new Error("Invalid Social Identity Address");
  return profile;
};

export const sendPost = async (
  post: FeedItem<ActivityContentNote>
): Promise<void> => {
  if (!post.content) return;

  const hash = await storeActivityContent(post.content);
  const announcement = await buildAndSignPostAnnouncement(hash, post);

  const batchData = await core.batch.createFile(hash + ".parquet", [
    announcement,
  ]);

  const publication = buildPublication(
    batchData,
    core.announcements.AnnouncementType.Broadcast
  );

  await core.contracts.publisher.publish([publication]);
};

export const sendReply = async (
  reply: FeedItem<ActivityContentNote>,
  inReplyTo: HexString
): Promise<void> => {
  if (!reply.content || !inReplyTo) return;

  const hash = await storeActivityContent(reply.content);
  const announcement = await buildAndSignReplyAnnouncement(
    hash,
    reply.fromAddress,
    inReplyTo
  );

  const batchData = await core.batch.createFile(hash + ".parquet", [
    announcement,
  ]);

  const publication = buildPublication(
    batchData,
    core.announcements.AnnouncementType.Reply
  );

  await core.contracts.publisher.publish([publication]);
};

export const startPostSubscription = (
  dispatch: ThunkDispatch<any, Record<string, any>, AnyAction>
): void => {
  dispatch(clearFeedItems());
  core.contracts.subscription.subscribeToBatchPublications(
    handleBatchAnnouncement(dispatch),
    {
      fromBlock: 0,
    }
  );
};

export const setupProvider = (walletType: WalletType): void => {
  let eth;

  if (walletType === WalletType.TORUS) {
    eth = torusWallet.getWeb3().currentProvider;
  } else if (walletType === WalletType.METAMASK) {
    const global: any = window;
    eth = global.ethereum;

    if (!eth) {
      throw new Error(
        "Could not create provider, because ethereum has not been set"
      );
    }
  } else {
    throw new Error(
      `Unknown walletType attempting to setup provider: ${walletType}`
    );
  }

  const provider = new providers.Web3Provider(eth);
  setConfig({
    provider: provider,
    signer: provider.getSigner(),
    store: new Store(),
  });
};

const buildPublication = (
  batchData: BatchFileData,
  type: AnnouncementType.Broadcast | AnnouncementType.Reply
): Publication => {
  return {
    announcementType: type,
    fileUrl: batchData.url.toString(),
    fileHash: batchData.hash,
  };
};

// TODO: move this dispatch code into a callback for subscribe
const dispatchActivityContent = (
  dispatch: Dispatch,
  message: BroadcastAnnouncement,
  activityContent: ActivityContentNote | ActivityContentProfile,
  blockNumber: number
) => {
  if (isActivityContentNote(activityContent)) {
    return dispatchFeedItem(
      dispatch,
      message,
      activityContent as ActivityContentNote,
      blockNumber
    );
  } else if (isActivityContentProfile(activityContent)) {
    return dispatchProfile(
      dispatch,
      message,
      activityContent as ActivityContentProfile,
      blockNumber
    );
  } else {
    //If we add a new type to the union it will error unless it's handled.
    throw new Error(
      `unknown activity content type: ${JSON.stringify(activityContent)}`
    );
  }
};

const dispatchFeedItem = (
  dispatch: Dispatch,
  message: BroadcastAnnouncement | ReplyAnnouncement,
  content: ActivityContentNote,
  blockNumber: number
) => {
  const decoder = new TextDecoder();

  if (!content.published) throw new Error("timestamp is required");
  // new Date(content.published).getTime()
  const timestamp = Date.parse(content.published);
  dispatch(
    addFeedItem({
      fromAddress: decoder.decode((message.fromId as any) as Uint8Array),
      blockNumber: blockNumber,
      hash: decoder.decode((message.contentHash as any) as Uint8Array),
      timestamp: timestamp,
      uri: decoder.decode((message.url as any) as Uint8Array),
      content: content,
      inReplyTo:
        message.announcementType === core.announcements.AnnouncementType.Reply
          ? decoder.decode((message.inReplyTo as any) as Uint8Array)
          : undefined,
    })
  );
};

const dispatchProfile = (
  dispatch: Dispatch,
  message: BroadcastAnnouncement,
  profile: ActivityContentProfile,
  _blockNumber: number
) => {
  const decoder = new TextDecoder();

  dispatch(
    upsertProfile({
      ...profile,
      socialAddress: decoder.decode((message.fromId as any) as Uint8Array),
    })
  );
};

const handleBatchAnnouncement = (dispatch: Dispatch) => (
  announcement: BatchPublicationCallbackArgs
) => {
  core.batch
    .openURL((announcement.fileUrl.toString() as any) as URL)
    .then((reader: any) =>
      core.batch.readFile(reader, (announcementRow: AnnouncementType) => {
        const message = (announcementRow as unknown) as BroadcastAnnouncement;
        const decoder = new TextDecoder();

        const url = decoder.decode((message.url as any) as Uint8Array);
        fetch(url)
          .then((res) => res.json())
          .then((activityContent) =>
            dispatchActivityContent(
              dispatch,
              message,
              activityContent,
              announcement.blockNumber
            )
          )
          .catch((err) => console.log(err));
      })
    )
    .catch((err) => console.log(err));
};

const storeActivityContent = async (
  content: ActivityContentNote
): Promise<string> => {
  const hash = keccak256(core.activityContent.serialize(content));

  await fetch(
    `${process.env.REACT_APP_UPLOAD_HOST}/upload?filename=${encodeURIComponent(
      hash + ".json"
    )}`,
    {
      method: "POST",
      mode: "cors",
      body: JSON.stringify(content),
    }
  );
  return hash;
};

const buildAndSignPostAnnouncement = async (
  hash: string,
  post: FeedItem<ActivityContentNote>
): Promise<SignedBroadcastAnnouncement> => ({
  ...core.announcements.createBroadcast(
    post.fromAddress,
    `${process.env.REACT_APP_UPLOAD_HOST}/${hash}.json`,
    hash
  ),
  signature: "0x00000000", // TODO: call out to wallet to get this signed
});

const buildAndSignReplyAnnouncement = async (
  hash: string,
  replyFromAddress: HexString,
  replyInReplyTo: HexString
): Promise<SignedReplyAnnouncement> => ({
  ...core.announcements.createReply(
    replyFromAddress,
    `${process.env.REACT_APP_UPLOAD_HOST}/${hash}.json`,
    hash,
    replyInReplyTo
  ),
  signature: "0x00000000", // TODO: call out to wallet to get this signed
});
