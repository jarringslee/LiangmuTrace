import { useRef } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Alert, App, Button, Form, Input, Modal, Typography } from 'antd'
import { registerBuyer } from '../../services/accounts'
import type { RegisterBuyerInput } from '../../types/accounts'
import AccountIdentityFields from './AccountIdentityFields'

export default function BuyerRegistration({ onClose, onRegistered }: { onClose: () => void; onRegistered: (username: string) => void }) {
  const { message } = App.useApp()
  const lock = useRef(false)
  const mutation = useMutation({ mutationFn: registerBuyer, retry: false })
  const submit = async (input: RegisterBuyerInput) => {
    if (lock.current || mutation.isPending) return
    lock.current = true
    try {
      const account = await mutation.mutateAsync(input)
      message.success('注册成功，请使用刚设置的密码登录采购商账号')
      onRegistered(account.username)
    } catch { /* mutation.error 保留可读提示，不自动重试注册写入。 */ }
    finally { lock.current = false }
  }
  return <Modal open title="注册采购商" footer={null} onCancel={() => { if (!lock.current) onClose() }}
    closable={!mutation.isPending} keyboard={!mutation.isPending} mask={{ closable: !mutation.isPending }} destroyOnHidden>
    <Typography.Paragraph type="secondary">注册仅开通采购商身份及独立采购组织，不加入他人的组织。邮箱暂不验证，也不提供找回密码。</Typography.Paragraph>
    {mutation.error && <Alert showIcon type="error" title={mutation.error.message} style={{ marginBottom: 12 }} />}
    <Form<RegisterBuyerInput> name="buyerRegistration" layout="vertical" disabled={mutation.isPending} onFinish={submit} autoComplete="off">
      <AccountIdentityFields />
      <Form.Item name="organizationName" label="采购组织名称" rules={[{ required: true, whitespace: true, message: '请输入采购组织名称' }]}>
        <Input maxLength={80} placeholder="例如：个人采购演示组织" />
      </Form.Item>
      <Button type="primary" htmlType="submit" loading={mutation.isPending} block>注册并返回登录</Button>
    </Form>
  </Modal>
}
