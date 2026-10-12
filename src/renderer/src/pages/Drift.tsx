import AiCheck from './AiCheck'
import type { PageProps } from '../App'

export default function Drift(props: PageProps) {
  return (
    <div className="drift-page">
      <AiCheck {...props} />
    </div>
  )
}
