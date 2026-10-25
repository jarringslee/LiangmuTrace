import { useEffect, useRef, useState } from 'react'
import { Alert, App, Button, Form, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd'
import { useAccounts } from '../../hooks/useAccounts'
import { BUSINESS_ROLE_LABEL, type BusinessAccount, type BusinessRole, type CreateAccountInput } from '../../types/accounts'
import AccountIdentityFields from './AccountIdentityFields'
import { getAuthRevision } from '../../utils/auth'

export default function AccountManager({ onClose }: { onClose: () => void }) {
  const { message, modal } = App.useApp()
  const { query, create, setStatus } = useAccounts()
  const [form] = Form.useForm<CreateAccountInput>()
  const [creating, setCreating] = useState(false)
  const [keyword, setKeyword] = useState('')
  const lock = useRef(false)
  const revision = useRef(getAuthRevision())
  const mounted = useRef(true)
  const confirmRef = useRef<ReturnType<typeof modal.confirm> | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; confirmRef.current?.destroy() }
  }, [])
  const sameIdentity = () => mounted.current && revision.current === getAuthRevision()
  const selectedRole = Form.useWatch('role', form) as BusinessRole | undefined
  const busy = create.isPending || setStatus.isPending
  const ready = query.isSuccess && !query.isFetching && !query.isPaused && !busy
  const data = query.data
  const organizations = data?.organizations.filter(item => item.type === selectedRole) ?? []
  const rows = data?.users.filter(item => [item.username, item.displayName, item.organizationName ?? ''].some(text => text.includes(keyword.trim()))) ?? []
  const submit = async (input: CreateAccountInput) => {
    if (lock.current || !ready || !sameIdentity() || !organizations.some(item => item.id === input.organizationId)) return
    lock.current = true
    try { await create.mutateAsync(input); message.success('账号已创建，请自行向使用者交付初始密码'); form.resetFields(); setCreating(false) }
    catch { /* 保留表单与错误，不自动重复创建。 */ }
    finally { lock.current = false }
  }
  const changeStatus = (account: BusinessAccount) => {
    if (lock.current || !ready || !sameIdentity()) return
    const status = account.status === 'active' ? 'disabled' : 'active'
    confirmRef.current = modal.confirm({ title: `确认${status === 'disabled' ? '停用' : '启用'} ${account.username}？`,
      content: status === 'disabled' ? '停用后不能登录或继续访问接口；历史批次、消息和审核记录保留。' : '恢复账号状态；所属组织也须启用才能登录。',
      okText: '确认', cancelText: '取消',
      onOk: async () => {
        if (lock.current || !sameIdentity()) return
        lock.current = true
        try { await setStatus.mutateAsync({ id: account.id, status }); message.success('账号状态已更新') }
        finally { lock.current = false }
      },
    })
  }
  return <Modal open title="业务账号管理" width={920} footer={null} destroyOnHidden onCancel={() => { if (!lock.current) onClose() }}
    closable={!busy} keyboard={!busy} mask={{ closable: !busy }}>
    <Typography.Paragraph type="secondary">仅管理种植商、加工商、采购商账号；不创建或停用管理员。停用不是删除，历史记录不会丢失。</Typography.Paragraph>
    {(query.error || create.error || setStatus.error) && <Alert showIcon type="error" title={(query.error ?? create.error ?? setStatus.error)?.message}
      action={query.error ? <Button onClick={() => void query.refetch()}>重试读取</Button> : undefined} style={{ marginBottom: 12 }} />}
    {data?.truncated && <Alert type="info" title="当前最多显示前200条账号及前200个组织，暂不提供大规模分页管理。" />}
    <Space wrap style={{ marginBottom: 12 }}>
      <Button type="primary" disabled={!ready} onClick={() => { setCreating(!creating); form.resetFields() }}>{creating ? '收起创建表单' : '创建业务账号'}</Button>
      <Button disabled={busy} onClick={() => void query.refetch()}>刷新</Button>
      <Input.Search placeholder="搜索账号、姓名或组织" value={keyword} onChange={event => setKeyword(event.target.value)} allowClear style={{ maxWidth: '100%', width: 250 }} />
    </Space>
    {creating && <Form<CreateAccountInput> name="accountCreation" form={form} layout="vertical" disabled={!ready} onFinish={submit} autoComplete="off">
      <Form.Item name="role" label="角色" rules={[{ required: true, message: '请选择角色' }]}>
        <Select options={Object.entries(BUSINESS_ROLE_LABEL).map(([value, label]) => ({ value, label }))} onChange={() => form.setFieldValue('organizationId', undefined)} />
      </Form.Item>
      <Form.Item name="organizationId" label="所属组织" rules={[{ required: true, message: '请选择匹配的组织' }]}>
        <Select disabled={!selectedRole} options={organizations.map(item => ({ value: item.id, label: item.name }))} placeholder="选择已有启用组织" />
      </Form.Item>
      <AccountIdentityFields />
      <Form.Item><Button type="primary" htmlType="submit" loading={create.isPending}>创建账号</Button></Form.Item>
    </Form>}
    <Table<BusinessAccount> rowKey="id" size="small" loading={query.isPending || query.isFetching} dataSource={rows} scroll={{ x: 720 }} pagination={{ pageSize: 6 }} columns={[
      { title: '账号', dataIndex: 'username' }, { title: '姓名', dataIndex: 'displayName' },
      { title: '角色', render: (_, account) => BUSINESS_ROLE_LABEL[account.role] },
      { title: '组织', render: (_, account) => `${account.organizationName ?? '未绑定'}${account.organizationEnabled === false ? '（组织停用）' : ''}` },
      { title: '状态', render: (_, account) => <Tag color={account.status === 'active' ? 'green' : 'default'}>{account.status === 'active' ? '启用' : '停用'}</Tag> },
      { title: '操作', render: (_, account) => <Button type="link" danger={account.status === 'active'} disabled={!ready}
        loading={setStatus.isPending && setStatus.variables?.id === account.id} onClick={() => changeStatus(account)}>{account.status === 'active' ? '停用' : '启用'}</Button> },
    ]} />
  </Modal>
}
