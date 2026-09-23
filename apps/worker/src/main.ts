import { log } from '@rjpos/logging';
import { loadEnvironment } from '@rjpos/config';

loadEnvironment();
log('info', 'RJ POS worker started', { requestId: 'worker-startup' });
