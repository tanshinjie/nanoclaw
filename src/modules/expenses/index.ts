import { registerMessageObserver } from '../../router.js';
import { log } from '../../log.js';
import { captureExpenseMessage } from './capture.js';

registerMessageObserver(captureExpenseMessage);

log.info('Expense capture module loaded');
