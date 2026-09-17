import PushPlugin from './PushPlugin';
import {offlinePushConfig} from '../config';
import {Platform} from 'react-native';

export function configureOfflinePush(nim: any): void {
  if ((Platform.OS as string) === 'harmony') {
    console.log('[NIM][offlinePush] HarmonyOS push integration is deferred');
    return;
  }

  const settingService = nim?.V2NIMSettingService;
  if (!settingService?.setOfflinePushConfig) {
    throw new Error(
      'A V2NIM instance is required before configuring offline push.',
    );
  }

  console.log('[NIM][offlinePush] setOfflinePushConfig start');
  settingService.setOfflinePushConfig(PushPlugin, offlinePushConfig);
  console.log('[NIM][offlinePush] setOfflinePushConfig completed');
}
