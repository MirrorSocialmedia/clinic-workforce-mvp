import { Inbox } from 'lucide-react'

export function EmptyState({ text, icon: Icon = Inbox }: { text: string; icon?: any }) {
 return (
 <div className="flex flex-col items-center justify-center py-12 text-slate-400">
 <Icon size={40} strokeWidth={1.5} />
 <p className="mt-3 text-sm">{text}</p>
 </div>
 )
}
