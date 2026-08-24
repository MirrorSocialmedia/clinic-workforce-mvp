/**
 * Apricot endpoint 常數 permanent guard（pre-pilot-fixes MD v1.0 §C）— cwi-prefix-20260824-c1
 *
 * 五條 path 逐字 assert = 實錄字串（checkClash/status 含 encodeURIComponent 後結果）。
 * 背景：CHECK_CLASH_PATH 曾經 RECONSTRUCTED 錯三處 → checkClash 必 404，
 * 而「非陣列照行」規則令佢靜默當通過 = slot race 檢查失效。
 * 將來邊個再 RECONSTRUCT 錯即紅。純字串斷言，零 mock、唔打真 Apricot。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BOOKING_CREATE_PATH,
  BOOKING_REMOVE_PATH,
  BOOKING_STATUS_PATH,
  CHECK_CLASH_PATH,
  DICTIONARY_PATHS,
} from './write-booking'

describe('Apricot endpoint path 常數（MD v1.0 實錄 guard）', () => {
  it('BOOKING_CREATE_PATH 逐字 = 實錄', () => {
    assert.equal(BOOKING_CREATE_PATH, '/services/aepsmsope/api/booking-details')
  })

  it('BOOKING_REMOVE_PATH 逐字 = 實錄', () => {
    assert.equal(
      BOOKING_REMOVE_PATH,
      '/services/aepsmsope/api/booking-details/remove?recurApplyType=0',
    )
  })

  it('BOOKING_STATUS_PATH(id, status) 逐字 = 實錄（含 id encode）', () => {
    assert.equal(
      BOOKING_STATUS_PATH('x', 102),
      '/services/aepsmsope/api/appointments/x/updateStatus?status=102',
    )
  })

  it('CHECK_CLASH_PATH 逐字 = 實錄（aepsmsope/booking-details + practitioner/clinic 中段 + startTime/endTime encode）', () => {
    assert.equal(
      CHECK_CLASH_PATH(
        'p1',
        'c1',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
      ),
      '/services/aepsmsope/api/booking-details/checkClash/practitioner/p1/clinic/c1/DOCTOR_LOCATION?startTime=2026-01-01T00%3A00%3A00.000Z&endTime=2026-01-02T00%3A00%3A00.000Z&bookingId=',
    )
  })

  it('DICTIONARY_PATHS 兩條逐字 = 實錄（?size=1024）', () => {
    assert.equal(DICTIONARY_PATHS.VISIT_REASON, '/services/aepsmsope/api/visit-reasons?size=1024')
    assert.equal(DICTIONARY_PATHS.BOOKING_TYPE, '/services/aepsmsope/api/booking-types?size=1024')
  })
})
