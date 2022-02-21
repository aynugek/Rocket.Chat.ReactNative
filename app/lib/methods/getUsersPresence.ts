import { InteractionManager } from 'react-native';
import { sanitizedRaw } from '@nozbe/watermelondb/RawRecord';

import { IActiveUsers } from '../../reducers/activeUsers';
import { compareServerVersion } from '../utils';
import { store as reduxStore } from '../auxStore';
import { setActiveUsers } from '../../actions/activeUsers';
import { setUser } from '../../actions/login';
import database from '../database';
import { IRocketChat, IUser } from '../../definitions';
import sdk from '../rocketchat/services/sdk';

export function subscribeUsersPresence(this: IRocketChat) {
	const serverVersion = reduxStore.getState().server.version as string;

	// if server is lower than 1.1.0
	if (compareServerVersion(serverVersion, 'lowerThan', '1.1.0')) {
		if (this.activeUsersSubTimeout) {
			clearTimeout(this.activeUsersSubTimeout);
			this.activeUsersSubTimeout = false;
		}
		this.activeUsersSubTimeout = setTimeout(() => {
			sdk.subscribe('activeUsers');
		}, 5000);
	} else if (compareServerVersion(serverVersion, 'lowerThan', '4.1.0')) {
		sdk.subscribe('stream-notify-logged', 'user-status');
	}

	// RC 0.49.1
	sdk.subscribe('stream-notify-logged', 'updateAvatar');
	// RC 0.58.0
	sdk.subscribe('stream-notify-logged', 'Users:NameChanged');
}

let ids: string[] = [];

export default async function getUsersPresence() {
	const serverVersion = reduxStore.getState().server.version as string;
	const { user: loggedUser } = reduxStore.getState().login;

	// if server is greather than or equal 1.1.0
	if (compareServerVersion(serverVersion, 'greaterThanOrEqualTo', '1.1.0')) {
		let params = {};

		// if server is greather than or equal 3.0.0
		if (compareServerVersion(serverVersion, 'greaterThanOrEqualTo', '3.0.0')) {
			// if not have any id
			if (!ids.length) {
				return;
			}
			// Request userPresence on demand
			params = { ids: ids.join(',') };
		}

		try {
			// RC 1.1.0
			const result = (await sdk.get('users.presence' as any, params as any)) as any;

			if (compareServerVersion(serverVersion, 'greaterThanOrEqualTo', '4.1.0')) {
				sdk.subscribeRaw('stream-user-presence', ['', { added: ids }]);
			}

			if (result.success) {
				const { users } = result;

				const activeUsers = ids.reduce((ret: IActiveUsers, id) => {
					const user = users.find((u: IUser) => u._id === id) ?? { _id: id, status: 'offline' };
					const { _id, status, statusText } = user;

					if (loggedUser && loggedUser.id === _id) {
						reduxStore.dispatch(setUser({ status, statusText }));
					}

					ret[_id] = { status, statusText };
					return ret;
				}, {});
				InteractionManager.runAfterInteractions(() => {
					reduxStore.dispatch(setActiveUsers(activeUsers));
				});
				ids = [];

				const db = database.active;
				const userCollection = db.get('users');
				users.forEach(async (user: IUser) => {
					try {
						const userRecord = await userCollection.find(user._id);
						await db.write(async () => {
							await userRecord.update(u => {
								Object.assign(u, user);
							});
						});
					} catch (e) {
						// User not found
						await db.write(async () => {
							await userCollection.create(u => {
								u._raw = sanitizedRaw({ id: user._id }, userCollection.schema);
								Object.assign(u, user);
							});
						});
					}
				});
			}
		} catch {
			// do nothing
		}
	}
}

let usersTimer: number | null = null;
export function getUserPresence(uid: string) {
	if (!usersTimer) {
		usersTimer = setTimeout(() => {
			getUsersPresence();
			usersTimer = null;
		}, 2000);
	}

	if (uid) {
		ids.push(uid);
	}
}