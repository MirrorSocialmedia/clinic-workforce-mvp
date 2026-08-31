import prisma from '@/lib/prisma'
import { calculateTimeBank } from '@/lib/payroll-engine'

async function main(){
const EMP = 'e2eearlyconvemp0831'
const monthDate = new Date('2026-08-01T00:00:00+08:00')
const tb = await calculateTimeBank(EMP, monthDate, { negative_carry: 'next_month' }, prisma)
console.log('CONV_TB ' + JSON.stringify({
  convertedMinutes: tb.convertedMinutes,
  leaveConvertMinutes: tb.leaveConvertMinutes,
  leaveSwapBackMinutes: tb.leaveSwapBackMinutes,
  balance: tb.balance,
  carriedFrom: tb.carriedFrom,
}))
  }
main().catch(e=>{console.error('CONV_FAIL',e);process.exit(1)}).finally(()=>prisma.$disconnect())
