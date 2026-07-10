'use client'

import { useState, useCallback, useEffect } from 'react'
import { Wallet, ClipboardList } from 'lucide-react'
import type { PayRuleConfigModular } from '@/lib/payroll-engine'
import { todayHK } from '@/lib/hk-date'

type BaseType = 'monthly' | 'hourly' | 'daily' | 'split'

const BASE_TYPE_LABELS: Record<BaseType, string> = {
  monthly: '月薪',
  hourly: '時薪',
  daily: '日薪',
  split: '拆帳',
}

const BASE_TYPE_TO_PAY_TYPE: Record<BaseType, 'MONTHLY' | 'DAILY' | 'HOURLY' | 'SPLIT'> = {
  monthly: 'MONTHLY',
  hourly: 'HOURLY',
  daily: 'DAILY',
  split: 'SPLIT',
}

const PAY_TYPE_TO_BASE_TYPE: Record<string, BaseType> = {
  MONTHLY: 'monthly',
  HOURLY: 'hourly',
  DAILY: 'daily',
  SPLIT: 'split',
}

// ── Default modifier values ──────────────────────────────────────

const DEFAULT_MODIFIERS: PayRuleConfigModular['modifiers'] = {
  attendance_bonus: {
    amount: 500,
    cancel_if: {
      late_minutes_exceed: 30,
      late_is_cumulative: true,
      any_unplanned_leave: true,
      any_absence: true,
    },
  },
  overtime: {
    mode: 'time_off',
    multiplier: 1.5,
    threshold: 8,
  },
  late_policy: {
    deduct_salary: false,
    affects_bonus: true,
    offset_from_time_bank: true,
  },
  time_bank: {
    negative_carry: 'next_month',
  },
  working_days: {
    rest_days: [6, 0],
    count_public_holidays: true,
  },
}

function buildDefaultConfig(baseType: BaseType): PayRuleConfigModular {
  const config: PayRuleConfigModular = { base_type: baseType }

  switch (baseType) {
    case 'monthly':
      config.monthly_salary = 50000
      break
    case 'hourly':
      config.hourly_rate = 180
      break
    case 'daily':
      config.daily_rate = 1500
      break
    case 'split':
      config.split_ratio = 70
      config.base_guarantee = 20000
      break
  }

  config.modifiers = structuredClone(DEFAULT_MODIFIERS)
  return config
}

// ── Section styles ───────────────────────────────────────────────

const sectionStyle: React.CSSProperties = {
  marginBottom: 20,
}

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: '#1a1a2e',
  marginBottom: 12,
  paddingBottom: 6,
  borderBottom: '1px solid #eee',
}

const modifierToggleStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 12px',
  marginBottom: 8,
  background: '#f9f9f9',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 14,
  fontWeight: 500,
  border: '1px solid #eee',
}

const modifierBodyStyle: React.CSSProperties = {
  marginLeft: 20,
  paddingLeft: 16,
  borderLeft: '2px solid #eee',
  marginBottom: 12,
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 8,
  fontSize: 14,
}

const radioGroupStyle: React.CSSProperties = {
  display: 'flex',
  gap: 16,
  flexWrap: 'wrap',
}

const tagStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 600,
  background: '#e3f2fd',
  color: '#1565c0',
  marginRight: 4,
  marginBottom: 4,
}

const checkboxLabelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 13,
  cursor: 'pointer',
}

// ── Components ───────────────────────────────────────────────────

interface RuleComposerModalProps {
  employeeId: string
  ruleId?: string  // optional — if set, directly edit this rule
  onClose: () => void
  onSuccess: () => void
}

export function RuleComposerModal({ employeeId, ruleId: initialRuleId, onClose, onSuccess }: RuleComposerModalProps) {
  const [baseType, setBaseType] = useState<BaseType>('monthly')
  const [config, setConfig] = useState<PayRuleConfigModular>(buildDefaultConfig('monthly'))
  const [effectiveFrom, setEffectiveFrom] = useState(todayHK())
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [ruleId, setRuleId] = useState<string | undefined>(initialRuleId)

  // ── Load existing active rule on mount ──────────────────────────
  useEffect(() => {
    loadExistingRule()
  }, [employeeId])

  async function loadExistingRule() {
    try {
      const res = await fetch(`/api/employees/${employeeId}/pay-rules`, { credentials: 'include' })
      const rules = await res.json()
      if (!Array.isArray(rules)) return

      // Use the passed ruleId if valid, otherwise find active rule
      let targetRule = initialRuleId
        ? rules.find((r: any) => r.id === initialRuleId)
        : rules.find((r: any) => r.isActive)

      if (!targetRule) return

      const ruleIdToUse = targetRule.id
      setRuleId(ruleIdToUse)

      // Parse modular config from configJson
      let modularConfig: PayRuleConfigModular | null = null
      if (targetRule.configJson) {
        try {
          modularConfig = typeof targetRule.configJson === 'string'
            ? JSON.parse(targetRule.configJson)
            : targetRule.configJson
        } catch { /* use defaults */ }
      }

      if (modularConfig && modularConfig.base_type) {
        const bt = modularConfig.base_type as BaseType
        setBaseType(bt)
        setConfig({ ...modularConfig })
      } else {
        // Fallback: derive baseType from payType
        const bt = PAY_TYPE_TO_BASE_TYPE[targetRule.payType] || 'monthly'
        setBaseType(bt)
        setConfig(buildDefaultConfig(bt))
      }

      // Set effectiveFrom from existing rule
      if (targetRule.effectiveFrom) {
        const d = new Date(targetRule.effectiveFrom)
        const yyyy = d.getFullYear()
        const mm = String(d.getMonth() + 1).padStart(2, '0')
        const dd = String(d.getDate()).padStart(2, '0')
        setEffectiveFrom(`${yyyy}-${mm}-${dd}`)
      }
    } catch (err) {
      console.error('Failed to load existing rule:', err)
    }
  }

  // Toggle modifier enable/disable by setting the modifier to undefined or restoring defaults
  const toggleModifier = useCallback(
    (key: keyof NonNullable<PayRuleConfigModular['modifiers']>) => {
      setConfig((prev) => {
        const next = { ...prev }
        const mods = next.modifiers ? { ...next.modifiers } : {}
        if (mods[key]) {
          delete mods[key]
        } else {
          mods[key] = structuredClone((DEFAULT_MODIFIERS as any)[key] || {})
        }
        next.modifiers = mods
        return next
      })
    },
    []
  )

  const updateBaseParam = useCallback((key: string, value: number | undefined) => {
    setConfig((prev) => ({ ...prev, [key]: value }))
  }, [])

  // Change base type — rebuild config with defaults
  const handleBaseTypeChange = useCallback((type: BaseType) => {
    setBaseType(type)
    setConfig(buildDefaultConfig(type))
  }, [])

  const isEdit = !!ruleId
  const titleText = isEdit ? '編輯薪酬規則' : '新增薪酬規則'
  const submitText = submitting
    ? (isEdit ? '保存中...' : '新增中...')
    : (isEdit ? '保存修改' : '新增薪酬規則')

  // ── Submit ──────────────────────────────────────────────────────

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!effectiveFrom) {
      setError('請設定生效日期')
      return
    }

    // Validate base amount
    if (baseType === 'monthly' && (!config.monthly_salary || config.monthly_salary <= 0)) {
      setError('請輸入月薪金額')
      return
    }
    if (baseType === 'hourly' && (!config.hourly_rate || config.hourly_rate <= 0)) {
      setError('請輸入時薪金額')
      return
    }
    if (baseType === 'daily' && (!config.daily_rate || config.daily_rate <= 0)) {
      setError('請輸入日薪金額')
      return
    }
    if (baseType === 'split' && (!config.split_ratio || config.split_ratio <= 0)) {
      setError('請輸入拆帳比例')
      return
    }

    setSubmitting(true)

    try {
      const isEditing = !!ruleId
      const url = isEditing
        ? `/api/employees/${employeeId}/pay-rules/${ruleId}`
        : `/api/employees/${employeeId}/pay-rules`
      const method = isEditing ? 'PUT' : 'POST'

      const res = await fetch(url, {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payType: BASE_TYPE_TO_PAY_TYPE[baseType],
          baseAmount:
            baseType === 'monthly'
              ? config.monthly_salary
              : baseType === 'hourly'
                ? config.hourly_rate
                : baseType === 'daily'
                  ? config.daily_rate
                  : config.split_ratio,
          modularConfig: config,
          ...(method === 'POST' ? { effectiveFrom } : {}),
        }),
      })

      const data = await res.json()
      if (!res.ok) {
        setError(data.error || (isEditing ? '更新薪酬規則失敗' : '新增薪酬規則失敗'))
        return
      }

      onSuccess()
    } catch (err: any) {
      setError(err.message || (ruleId ? '更新薪酬規則失敗' : '新增薪酬規則失敗'))
    } finally {
      setSubmitting(false)
    }
  }

  const modifiers = config.modifiers || {}

  // ── Render ──────────────────────────────────────────────────────

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        zIndex: 1000,
        overflowY: 'auto',
        padding: '40px 0',
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{
          width: '100%',
          maxWidth: 560,
          padding: 24,
          margin: '0 16px',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 20,
          }}
        >
          <h2 style={{ margin: 0 }} className="flex items-center gap-2"><Wallet size={20} /> {titleText}</h2>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: 20,
              cursor: 'pointer',
              color: '#999',
              padding: '0 4px',
            }}
          >
            ×
          </button>
        </div>

        {error && (
          <div
            style={{
              background: '#fef2f2',
              color: '#dc2626',
              padding: '10px 14px',
              borderRadius: 6,
              marginBottom: 16,
              fontSize: 14,
            }}
          >
            {error}
          </div>
        )}

        <form onSubmit={submit}>
          {/* ═══ 1️⃣ Base Type ═══ */}
          <div style={sectionStyle}>
            <div style={sectionTitleStyle}>1️⃣ 基礎薪酬模式（選一）</div>
            <div style={radioGroupStyle}>
              {(['monthly', 'hourly', 'daily', 'split'] as BaseType[]).map((type) => (
                <label key={type} style={checkboxLabelStyle}>
                  <input
                    type="radio"
                    name="baseType"
                    checked={baseType === type}
                    onChange={() => handleBaseTypeChange(type)}
                  />
                  {BASE_TYPE_LABELS[type]}
                </label>
              ))}
            </div>
          </div>

          {/* Base parameters based on type */}
          <div style={{ ...sectionStyle, paddingLeft: 16, borderLeft: '2px solid #1a1a2e' }}>
            {baseType === 'monthly' && (
              <div className="form-group">
                <label>月薪金額 (HK$)</label>
                <input
                  type="number"
                  value={config.monthly_salary ?? ''}
                  onChange={(e) =>
                    updateBaseParam('monthly_salary', e.target.value ? Number(e.target.value) : undefined)
                  }
                  placeholder="如 50000"
                  min={0}
                />
              </div>
            )}

            {baseType === 'hourly' && (
              <div className="form-group">
                <label>時薪金額 (HK$)</label>
                <input
                  type="number"
                  value={config.hourly_rate ?? ''}
                  onChange={(e) =>
                    updateBaseParam('hourly_rate', e.target.value ? Number(e.target.value) : undefined)
                  }
                  placeholder="如 180"
                  min={0}
                  step="0.01"
                />
              </div>
            )}

            {baseType === 'daily' && (
              <div className="form-group">
                <label>日薪金額 (HK$)</label>
                <input
                  type="number"
                  value={config.daily_rate ?? ''}
                  onChange={(e) =>
                    updateBaseParam('daily_rate', e.target.value ? Number(e.target.value) : undefined)
                  }
                  placeholder="如 1500"
                  min={0}
                  step="0.01"
                />
              </div>
            )}

            {baseType === 'split' && (
              <>
                <div className="form-group">
                  <label>拆帳比例 (%)</label>
                  <input
                    type="number"
                    value={config.split_ratio ?? ''}
                    onChange={(e) =>
                      updateBaseParam('split_ratio', e.target.value ? Number(e.target.value) : undefined)
                    }
                    placeholder="如 70"
                    min={0}
                    max={100}
                  />
                </div>
                <div className="form-group">
                  <label>底薪保障 (HK$)</label>
                  <input
                    type="number"
                    value={config.base_guarantee ?? ''}
                    onChange={(e) =>
                      updateBaseParam('base_guarantee', e.target.value ? Number(e.target.value) : undefined)
                    }
                    placeholder="如 20000"
                    min={0}
                  />
                </div>
              </>
            )}
          </div>

          {/* ═══ 2️⃣ Modifiers ═══ */}
          <div style={sectionStyle}>
            <div style={sectionTitleStyle}>2️⃣ 薪酬修正模組（可選開關）</div>

            {/* ── Attendance Bonus ── */}
            <div style={modifierToggleStyle} onClick={() => toggleModifier('attendance_bonus')}>
              <input
                type="checkbox"
                checked={!!modifiers.attendance_bonus}
                onChange={() => toggleModifier('attendance_bonus')}
                onClick={(e) => e.stopPropagation()}
              />
              勤工獎
              {modifiers.attendance_bonus && (
                <span style={tagStyle}>${modifiers.attendance_bonus.amount}</span>
              )}
            </div>
            {modifiers.attendance_bonus && (
              <div style={modifierBodyStyle}>
                <div className="form-group">
                  <label>獎金金額 (HK$)</label>
                  <input
                    type="number"
                    value={modifiers.attendance_bonus.amount}
                    onChange={(e) => {
                      setConfig((prev) => ({
                        ...prev,
                        modifiers: {
                          ...prev.modifiers!,
                          attendance_bonus: {
                            ...prev.modifiers!.attendance_bonus!,
                            amount: Number(e.target.value) || 0,
                          },
                        },
                      }))
                    }}
                    min={0}
                  />
                </div>
                <div style={{ fontSize: 13, color: '#888', marginBottom: 8, fontWeight: 500 }}>
                  取消條件：
                </div>
                <label style={checkboxLabelStyle}>
                  <input
                    type="checkbox"
                    checked={!!modifiers.attendance_bonus.cancel_if?.late_minutes_exceed}
                    onChange={(e) => {
                      setConfig((prev) => ({
                        ...prev,
                        modifiers: {
                          ...prev.modifiers!,
                          attendance_bonus: {
                            ...prev.modifiers!.attendance_bonus!,
                            cancel_if: {
                              ...prev.modifiers!.attendance_bonus!.cancel_if,
                              late_minutes_exceed: e.target.checked
                                ? prev.modifiers!.attendance_bonus!.cancel_if?.late_minutes_exceed || 30
                                : undefined,
                            },
                          },
                        },
                      }))
                    }}
                  />
                  遲到超過{' '}
                  {modifiers.attendance_bonus.cancel_if?.late_minutes_exceed != null && (
                    <input
                      type="number"
                      value={modifiers.attendance_bonus.cancel_if.late_minutes_exceed}
                      onChange={(e) => {
                        setConfig((prev) => ({
                          ...prev,
                          modifiers: {
                            ...prev.modifiers!,
                            attendance_bonus: {
                              ...prev.modifiers!.attendance_bonus!,
                              cancel_if: {
                                ...prev.modifiers!.attendance_bonus!.cancel_if,
                                late_minutes_exceed: Number(e.target.value),
                              },
                            },
                          },
                        }))
                      }}
                      style={{ width: 60, padding: '2px 6px' }}
                      min={0}
                    />
                  )}{' '}
                  分鐘
                </label>
                <div style={{ paddingLeft: 20, marginTop: 4 }}>
                  <label style={checkboxLabelStyle}>
                    <input
                      type="radio"
                      name="lateCumulative"
                      checked={modifiers.attendance_bonus.cancel_if?.late_is_cumulative === true}
                      onChange={() => {
                        setConfig((prev) => ({
                          ...prev,
                          modifiers: {
                            ...prev.modifiers!,
                            attendance_bonus: {
                              ...prev.modifiers!.attendance_bonus!,
                              cancel_if: {
                                ...prev.modifiers!.attendance_bonus!.cancel_if,
                                late_is_cumulative: true,
                              },
                            },
                          },
                        }))
                      }}
                    />
                    當月累計
                  </label>
                  <label style={{ ...checkboxLabelStyle, marginLeft: 12 }}>
                    <input
                      type="radio"
                      name="lateCumulative"
                      checked={modifiers.attendance_bonus.cancel_if?.late_is_cumulative === false}
                      onChange={() => {
                        setConfig((prev) => ({
                          ...prev,
                          modifiers: {
                            ...prev.modifiers!,
                            attendance_bonus: {
                              ...prev.modifiers!.attendance_bonus!,
                              cancel_if: {
                                ...prev.modifiers!.attendance_bonus!.cancel_if,
                                late_is_cumulative: false,
                              },
                            },
                          },
                        }))
                      }}
                    />
                    單次最大
                  </label>
                </div>
                <label style={{ ...checkboxLabelStyle, marginTop: 4 }}>
                  <input
                    type="checkbox"
                    checked={modifiers.attendance_bonus.cancel_if?.any_unplanned_leave ?? false}
                    onChange={(e) => {
                      setConfig((prev) => ({
                        ...prev,
                        modifiers: {
                          ...prev.modifiers!,
                          attendance_bonus: {
                            ...prev.modifiers!.attendance_bonus!,
                            cancel_if: {
                              ...prev.modifiers!.attendance_bonus!.cancel_if,
                              any_unplanned_leave: e.target.checked,
                            },
                          },
                        },
                      }))
                    }}
                  />
                  有臨時請假
                </label>
                <label style={{ ...checkboxLabelStyle, marginTop: 4 }}>
                  <input
                    type="checkbox"
                    checked={modifiers.attendance_bonus.cancel_if?.any_absence ?? false}
                    onChange={(e) => {
                      setConfig((prev) => ({
                        ...prev,
                        modifiers: {
                          ...prev.modifiers!,
                          attendance_bonus: {
                            ...prev.modifiers!.attendance_bonus!,
                            cancel_if: {
                              ...prev.modifiers!.attendance_bonus!.cancel_if,
                              any_absence: e.target.checked,
                            },
                          },
                        },
                      }))
                    }}
                  />
                  缺勤即取消勤工獎（缺勤 1 天或以上 → 無勤工）
                </label>
              </div>
            )}

            {/* ── Overtime ── */}
            <div style={modifierToggleStyle} onClick={() => toggleModifier('overtime')}>
              <input
                type="checkbox"
                checked={!!modifiers.overtime}
                onChange={() => toggleModifier('overtime')}
                onClick={(e) => e.stopPropagation()}
              />
              加班處理
              {modifiers.overtime && (
                <span style={tagStyle}>
                  {modifiers.overtime.mode === 'time_off' ? '補時間' : `補加班費 ${modifiers.overtime.multiplier}x`}
                </span>
              )}
            </div>
            {modifiers.overtime && (
              <div style={modifierBodyStyle}>
                <div style={{ fontSize: 13, color: '#555', marginBottom: 8, fontWeight: 500 }}>
                  模式：
                </div>
                <div style={radioGroupStyle}>
                  <label style={checkboxLabelStyle}>
                    <input
                      type="radio"
                      name="overtimeMode"
                      checked={modifiers.overtime.mode === 'pay'}
                      onChange={() => {
                        setConfig((prev) => ({
                          ...prev,
                          modifiers: {
                            ...prev.modifiers!,
                            overtime: {
                              ...prev.modifiers!.overtime!,
                              mode: 'pay',
                            },
                          },
                        }))
                      }}
                    />
                    補加班費
                  </label>
                  <label style={{ ...checkboxLabelStyle, marginLeft: 12 }}>
                    <input
                      type="radio"
                      name="overtimeMode"
                      checked={modifiers.overtime.mode === 'time_off'}
                      onChange={() => {
                        setConfig((prev) => ({
                          ...prev,
                          modifiers: {
                            ...prev.modifiers!,
                            overtime: {
                              ...prev.modifiers!.overtime!,
                              mode: 'time_off',
                            },
                          },
                        }))
                      }}
                    />
                    補時間
                  </label>
                </div>
                {modifiers.overtime.mode === 'pay' && (
                  <div className="form-group" style={{ marginTop: 8 }}>
                    <label>倍率</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <input
                        type="number"
                        value={modifiers.overtime.multiplier ?? ''}
                        onChange={(e) => {
                          setConfig((prev) => ({
                            ...prev,
                            modifiers: {
                              ...prev.modifiers!,
                              overtime: {
                                ...prev.modifiers!.overtime!,
                                multiplier: Number(e.target.value) || undefined,
                              },
                            },
                          }))
                        }}
                        step="0.1"
                        min="1"
                        style={{ width: 80 }}
                      />
                      <span style={{ fontSize: 13, color: '#888' }}>x</span>
                    </div>
                  </div>
                )}
                <div className="form-group" style={{ marginTop: 8 }}>
                  <label>門檻（小時/日）</label>
                  <input
                    type="number"
                    value={modifiers.overtime.threshold ?? ''}
                    onChange={(e) => {
                      setConfig((prev) => ({
                        ...prev,
                        modifiers: {
                          ...prev.modifiers!,
                          overtime: {
                            ...prev.modifiers!.overtime!,
                            threshold: Number(e.target.value) || undefined,
                          },
                        },
                      }))
                    }}
                    step="0.5"
                    min="0"
                    style={{ width: 80 }}
                  />
                </div>
              </div>
            )}

            {/* ── Late Policy ── */}
            <div style={modifierToggleStyle} onClick={() => toggleModifier('late_policy')}>
              <input
                type="checkbox"
                checked={!!modifiers.late_policy}
                onChange={() => toggleModifier('late_policy')}
                onClick={(e) => e.stopPropagation()}
              />
              遲到政策
            </div>
            {modifiers.late_policy && (
              <div style={modifierBodyStyle}>
                <label style={checkboxLabelStyle}>
                  <input
                    type="checkbox"
                    checked={modifiers.late_policy.deduct_salary ?? false}
                    onChange={(e) => {
                      setConfig((prev) => ({
                        ...prev,
                        modifiers: {
                          ...prev.modifiers!,
                          late_policy: {
                            ...prev.modifiers!.late_policy!,
                            deduct_salary: e.target.checked,
                          },
                        },
                      }))
                    }}
                  />
                  遲到扣底薪
                </label>
                <label style={{ ...checkboxLabelStyle, marginTop: 4 }}>
                  <input
                    type="checkbox"
                    checked={modifiers.late_policy.affects_bonus ?? false}
                    onChange={(e) => {
                      setConfig((prev) => ({
                        ...prev,
                        modifiers: {
                          ...prev.modifiers!,
                          late_policy: {
                            ...prev.modifiers!.late_policy!,
                            affects_bonus: e.target.checked,
                          },
                        },
                      }))
                    }}
                  />
                  影響勤工獎
                </label>
                <label style={{ ...checkboxLabelStyle, marginTop: 4 }}>
                  <input
                    type="checkbox"
                    checked={modifiers.late_policy.offset_from_time_bank ?? false}
                    onChange={(e) => {
                      setConfig((prev) => ({
                        ...prev,
                        modifiers: {
                          ...prev.modifiers!,
                          late_policy: {
                            ...prev.modifiers!.late_policy!,
                            offset_from_time_bank: e.target.checked,
                          },
                        },
                      }))
                    }}
                  />
                  從時間帳戶抵扣
                </label>
              </div>
            )}

            {/* ── Time Bank ── */}
            <div style={modifierToggleStyle} onClick={() => toggleModifier('time_bank')}>
              <input
                type="checkbox"
                checked={!!modifiers.time_bank}
                onChange={() => toggleModifier('time_bank')}
                onClick={(e) => e.stopPropagation()}
              />
              時間帳戶
            </div>
            {modifiers.time_bank && (
              <div style={modifierBodyStyle}>
                <div className="form-group">
                  <label>負結餘處理</label>
                  <select
                    value={modifiers.time_bank.negative_carry || 'next_month'}
                    onChange={(e) => {
                      const val = e.target.value as 'next_month' | 'deduct_salary' | 'deduct_bonus' | 'reset'
                      setConfig((prev) => ({
                        ...prev,
                        modifiers: {
                          ...prev.modifiers!,
                          time_bank: {
                            negative_carry: val,
                          },
                        },
                      }))
                    }}
                  >
                    <option value="next_month">下一月欠起</option>
                    <option value="deduct_salary">扣除底薪</option>
                    <option value="deduct_bonus">扣除獎金</option>
                    <option value="reset">歸零</option>
                  </select>
                </div>
              </div>
            )}

            {/* ── Working Days ── */}
            <div style={modifierToggleStyle} onClick={() => toggleModifier('working_days')}>
              <input
                type="checkbox"
                checked={!!modifiers.working_days}
                onChange={() => toggleModifier('working_days')}
                onClick={(e) => e.stopPropagation()}
              />
              工作日設定
            </div>
            {modifiers.working_days && (
              <div style={modifierBodyStyle}>
                <div style={{ fontSize: 13, color: '#555', marginBottom: 8, fontWeight: 500 }}>
                  休息日：
                </div>
                <div style={radioGroupStyle}>
                  {[
                    [0, '週日'],
                    [1, '週一'],
                    [2, '週二'],
                    [3, '週三'],
                    [4, '週四'],
                    [5, '週五'],
                    [6, '週六'],
                  ].map(([day, label]) => {
                    const isSelected = modifiers.working_days!.rest_days?.includes(day as 0 | 1 | 2 | 3 | 4 | 5 | 6)
                    return (
                      <label key={day} style={checkboxLabelStyle}>
                        <input
                          type="checkbox"
                          checked={!!isSelected}
                          onChange={() => {
                            const current = modifiers.working_days!.rest_days || []
                            const next = isSelected
                              ? current.filter((d) => d !== day)
                              : [...current, day as number]
                            setConfig((prev) => ({
                              ...prev,
                              modifiers: {
                                ...prev.modifiers!,
                                working_days: {
                                  ...prev.modifiers!.working_days!,
                                  rest_days: next,
                                },
                              },
                            }))
                          }}
                        />
                        {label}
                      </label>
                    )
                  })}
                </div>
                <label style={{ ...checkboxLabelStyle, marginTop: 8 }}>
                  <input
                    type="checkbox"
                    checked={modifiers.working_days.count_public_holidays ?? false}
                    onChange={(e) => {
                      setConfig((prev) => ({
                        ...prev,
                        modifiers: {
                          ...prev.modifiers!,
                          working_days: {
                            ...prev.modifiers!.working_days!,
                            count_public_holidays: e.target.checked,
                          },
                        },
                      }))
                    }}
                  />
                  紅日算非工作日
                </label>
              </div>
            )}

            {/* ── Allowances ── */}
            <div style={modifierToggleStyle} onClick={() => toggleModifier('allowances')}>
              <input
                type="checkbox"
                checked={(modifiers.allowances || []).length > 0}
                onChange={() => {
                  if ((modifiers.allowances || []).length > 0) {
                    setConfig((prev) => ({
                      ...prev,
                      modifiers: { ...prev.modifiers!, allowances: [] },
                    }))
                  } else {
                    setConfig((prev) => ({
                      ...prev,
                      modifiers: {
                        ...prev.modifiers!,
                        allowances: [{ name: '交通津貼', amount: 500, type: 'fixed' }],
                      },
                    }))
                  }
                }}
                onClick={(e) => e.stopPropagation()}
              />
              津貼
              {modifiers.allowances && modifiers.allowances.length > 0 && (
                <span style={tagStyle}>{modifiers.allowances.length} 項</span>
              )}
            </div>
            {modifiers.allowances && modifiers.allowances.length > 0 && (
              <div style={modifierBodyStyle}>
                {modifiers.allowances.map((allowance, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: 'flex',
                      gap: 8,
                      alignItems: 'flex-end',
                      marginBottom: 8,
                      flexWrap: 'wrap',
                    }}
                  >
                    <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 120 }}>
                      <label style={{ fontSize: 12 }}>名稱</label>
                      <input
                        type="text"
                        value={allowance.name}
                        onChange={(e) => {
                          const next = [...modifiers.allowances!]
                          next[idx] = { ...next[idx], name: e.target.value }
                          setConfig((prev) => ({
                            ...prev,
                            modifiers: { ...prev.modifiers!, allowances: next },
                          }))
                        }}
                      />
                    </div>
                    <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 100 }}>
                      <label style={{ fontSize: 12 }}>金額</label>
                      <input
                        type="number"
                        value={allowance.amount}
                        onChange={(e) => {
                          const next = [...modifiers.allowances!]
                          next[idx] = { ...next[idx], amount: Number(e.target.value) || 0 }
                          setConfig((prev) => ({
                            ...prev,
                            modifiers: { ...prev.modifiers!, allowances: next },
                          }))
                        }}
                        min={0}
                      />
                    </div>
                    <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 100 }}>
                      <label style={{ fontSize: 12 }}>類型</label>
                      <select
                        value={allowance.type}
                        onChange={(e) => {
                          const next = [...modifiers.allowances!]
                          next[idx] = { ...next[idx], type: e.target.value as 'fixed' | 'conditional' }
                          setConfig((prev) => ({
                            ...prev,
                            modifiers: { ...prev.modifiers!, allowances: next },
                          }))
                        }}
                      >
                        <option value="fixed">固定</option>
                        <option value="conditional">條件</option>
                      </select>
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={() => {
                        const next = modifiers.allowances!.filter((_, i) => i !== idx)
                        setConfig((prev) => ({
                          ...prev,
                          modifiers: { ...prev.modifiers!, allowances: next },
                        }))
                      }}
                      style={{ marginBottom: 0 }}
                    >
                      刪除
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    const next = [
                      ...(modifiers.allowances || []),
                      { name: '', amount: 0, type: 'fixed' as const },
                    ]
                    setConfig((prev) => ({
                      ...prev,
                      modifiers: { ...prev.modifiers!, allowances: next },
                    }))
                  }}
                  style={{ background: '#f0f0f0', color: '#333' }}
                >
                  + 新增津貼
                </button>
              </div>
            )}
          </div>

          {/* ═══ 3️⃣ MPF 強積金 ═══ */}
          <div style={sectionStyle}>
            <div style={sectionTitleStyle}>3️⃣ 強積金 (MPF)</div>
            <label style={checkboxLabelStyle}>
              <input
                type="checkbox"
                checked={!!config.mpf?.enabled}
                onChange={(e) => {
                  setConfig((prev) => ({
                    ...prev,
                    mpf: e.target.checked
                      ? { enabled: true, rate: prev.mpf?.rate ?? 0.05, min: prev.mpf?.min ?? 7100, max: prev.mpf?.max ?? 30000 }
                      : { enabled: false, rate: 0.05, min: 7100, max: 30000 },
                  }))
                }}
              />
              啟用強積金扣除
            </label>
            {config.mpf?.enabled && (
              <div style={{ paddingLeft: 24, marginTop: 8 }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label style={{ fontSize: 12 }}>扣除比例 (%)</label>
                    <input
                      type="number"
                      value={config.mpf.rate ? (config.mpf.rate * 100) : 5}
                      onChange={(e) => {
                        setConfig((prev) => ({
                          ...prev,
                          mpf: { ...prev.mpf!, rate: Number(e.target.value) / 100 || 0.05 },
                        }))
                      }}
                      style={{ width: 80 }}
                      min="0"
                      max="100"
                      step="0.5"
                    />
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label style={{ fontSize: 12 }}>下限 (HK$)</label>
                    <input
                      type="number"
                      value={config.mpf.min ?? 7100}
                      onChange={(e) => {
                        setConfig((prev) => ({
                          ...prev,
                          mpf: { ...prev.mpf!, min: Number(e.target.value) || 7100 },
                        }))
                      }}
                      style={{ width: 100 }}
                      min="0"
                    />
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label style={{ fontSize: 12 }}>上限 (HK$)</label>
                    <input
                      type="number"
                      value={config.mpf.max ?? 30000}
                      onChange={(e) => {
                        setConfig((prev) => ({
                          ...prev,
                          mpf: { ...prev.mpf!, max: Number(e.target.value) || 30000 },
                        }))
                      }}
                      style={{ width: 100 }}
                      min="0"
                    />
                  </div>
                </div>
                <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                  MPF 以應發薪資 (Gross) 為計算基礎，扣除後為實發 (Net Pay)
                </div>
              </div>
            )}
          </div>

          {/* ═══ 4️⃣ Effective Date ═══ */}
          <div style={sectionStyle}>
            <div style={sectionTitleStyle}>4️⃣ 生效日期</div>
            <div className="form-group">
              <input
                type="date"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
              />
            </div>
          </div>

          {/* ═══ Config Preview (collapsed) ═══ */}
          <ConfigPreview config={config} />

          {/* ═══ Actions ═══ */}
          <div
            style={{
              display: 'flex',
              gap: 8,
              justifyContent: 'flex-end',
              marginTop: 20,
              paddingTop: 16,
              borderTop: '1px solid #eee',
            }}
          >
            <button
              type="button"
              onClick={onClose}
              className="btn"
              style={{ background: '#f0f0f0', color: '#333' }}
            >
              取消
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={submitting}
            >
              {submitText}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Config Preview ────────────────────────────────────────────────

function ConfigPreview({ config }: { config: PayRuleConfigModular }) {
  const [open, setOpen] = useState(false)

  return (
    <div
      style={{
        background: '#f9f9f9',
        borderRadius: 6,
        padding: 12,
        marginBottom: 16,
        fontSize: 12,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          cursor: 'pointer',
          color: '#888',
          fontSize: 12,
        }}
        onClick={() => setOpen(!open)}
      >
        <span className="flex items-center gap-1"><ClipboardList size={14} /> 配置預覽</span>
        <span>{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <pre
          style={{
            background: '#222',
            color: '#aed581',
            padding: 12,
            borderRadius: 4,
            marginTop: 8,
            overflowX: 'auto',
            fontSize: 11,
            lineHeight: 1.5,
          }}
        >
          {JSON.stringify(config, null, 2)}
        </pre>
      )}
    </div>
  )
}
